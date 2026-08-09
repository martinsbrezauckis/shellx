import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  RELEASE_UI_DEBUG_BROWSER_CLEANUP_ID,
  RELEASE_UI_DEBUG_CLEANUP_ID,
  RELEASE_UI_DEBUG_FIXTURES,
  RELEASE_UI_DEBUG_ORACLE_ID,
  RELEASE_UI_DEBUG_VAULT_LIFECYCLE_CLEANUP_ID,
  releaseUiDebugFixture,
  releaseUiDebugSurfaceCohort,
  type ReleaseUiDebugOwnedBookmark,
  type ReleaseUiDebugPatchStep,
  type ReleaseUiDebugSurface,
} from "../lib/release-ui-debug-surface-cohorts";
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
  cleanupDebugApiSessionFixture,
  prepareDebugApiSessionFixture,
  type DebugApiSessionFixture,
} from "./debug-api-session-fixture";
import {
  cleanupActivityFixture,
  prepareActivityFixture,
  type ActivityFixture,
} from "./ui-control-activity-browser-lifecycle";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-debug-surface-installed",
  kind: "ui-debug-surface",
  runtimeBinding: "attested-process",
  invocationTransport: "debug-api-direct",
  supportedFixtures: RELEASE_UI_DEBUG_FIXTURES.map((fixture) => fixture.id),
  supportedCleanups: [
    RELEASE_UI_DEBUG_CLEANUP_ID,
    RELEASE_UI_DEBUG_BROWSER_CLEANUP_ID,
    RELEASE_UI_DEBUG_VAULT_LIFECYCLE_CLEANUP_ID,
  ],
  supportedOracles: [RELEASE_UI_DEBUG_ORACLE_ID],
};

type Json = Record<string, unknown>;
type HighlightResult = {
  id?: string;
  status?: string;
  rect?: { width?: number; height?: number } | null;
  visibleRect?: { width?: number; height?: number } | null;
  message?: string | null;
};
type Connection = { base: string; token: string };
type AppUiBaseline = {
  bottomTab?: string;
  rightTab?: string;
  setupGuideDismissed?: boolean;
  activeTabId?: string;
  activeTab?: Record<string, unknown>;
};
type VaultDirectory = { keys?: unknown[]; entries?: Array<{ key?: unknown }> };
type OwnedVaultLifecycle = "setup-recovery-kit" | "configured-unlocked" | "configured-locked" | "configured-remembered";
type OwnedCwdPicker = { rootPath: string; pickerPath: string; label: string };
type OwnedGitRepo = { rootPath: string; repoPath: string };
type OwnedConnectionPreset = { id: string; baselineJson: string };
type OwnedFilesPane = { rootPath: string; directoryPath: string };
type OwnedPreviewFile = { rootPath: string; filePath: string };
type OwnedPendingAttachment = { rootPath: string; filePath: string };
type OwnedRendererEventProjection = {
  rootPath: string;
  attachmentPath: string;
  imagePath: string;
  videoPath: string;
};
type OwnedVaultAgentRequest = { actorId: string; requestId: string };
type OwnedVaultGrant = { grantId: string };
type OwnedWorkPreviewIssue = {
  nodeRoot: string;
  launchRoot: string;
  tabId: string;
  url: string | null;
};
type OwnedBrowserMissingRecipe = { rootPath: string };
const WORK_PREVIEW_ISSUE_ENTRY = "release-preview.html";
const WORK_PREVIEW_ISSUE_MARKER = "SHELLX_RELEASE_OWNED_WORK_PREVIEW_WARNING_035";
const WORK_PREVIEW_ISSUE_PAGE = `<!doctype html>
<title>ShellX release Work Preview issue</title>
<main>SHELLX_RELEASE_OWNED_WORK_PREVIEW_ISSUE_035</main>
<script>
addEventListener("load", () => parent.postMessage({
  kind: "shellx-preview-doctor",
  level: "warning",
  message: "${WORK_PREVIEW_ISSUE_MARKER}",
  source: "release-fixture",
  url: location.href,
  t: Date.now()
}, "*"));
</script>
`;
type VaultStatus = {
  mode?: unknown;
  unlocked?: unknown;
  recoveryConfirmed?: unknown;
  rememberedDeviceEnabled?: unknown;
};
type BrowserFixtureSetup = Extract<
  NonNullable<ReturnType<typeof releaseUiDebugFixture>>["setup"],
  { kind: "owned-browser-task" }
>;
type PreparedFixture = {
  debugSurface: ReleaseUiDebugSurface;
  cleanup: () => Promise<void>;
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) outcomes.push(await exerciseSurface(connection, assignment, request));
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

async function exerciseSurface(
  connection: Connection,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No visible effect was observed.",
  };
  const selector = assignment.surface.selector;
  const highlightId = `final-surface-${safeId(assignment.surface.id)}`;
  let prepared: PreparedFixture | null = null;
  try {
    if (!selector) throw new Error("surface inventory does not provide a stable selector");
    if (assignment.surface.dynamicSelector && selector.includes("*")) {
      throw new Error("dynamic surface selector contains an unresolved wildcard");
    }
    const cohort = releaseUiDebugSurfaceCohort(assignment.surface);
    if (!cohort || cohort.fixtureId !== assignment.fixtureId) {
      throw new Error(`surface is not bound to its exact UI debug cohort fixture ${assignment.fixtureId}`);
    }
    prepared = await prepareFixture(connection, assignment.fixtureId, request);
    await postUi(connection, prepared.debugSurface, {
      debugHighlights: [{ id: highlightId, selector, label: assignment.surface.name, color: "cyan" }],
    });
    outcome.invoke = "pass";
    const result = await waitForHighlight(
      connection,
      prepared.debugSurface,
      highlightId,
      selector,
      assignment.surface.name,
    );
    const rect = result.visibleRect ?? result.rect;
    if (!rect || Number(rect.width) <= 0 || Number(rect.height) <= 0) throw new Error("highlight resolved without a non-empty visible rectangle");
    outcome.present = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = `${selector} resolved on the ${prepared.debugSurface} renderer to a visible ${Number(rect.width)}x${Number(rect.height)} rectangle after its owned fixture state was established; no control activation was invoked or claimed.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      const surface = prepared?.debugSurface ?? "app";
      await postUi(connection, surface, { debugHighlights: [] });
      await waitForHighlightCleared(connection, surface, highlightId);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (prepared) {
      try {
        await prepared.cleanup();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const cleanupError = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "surface did not satisfy every required verdict";
  }
  return outcome;
}

async function prepareFixture(
  connection: Connection,
  fixtureId: string,
  request: ReleaseSurfaceDriverRequest,
): Promise<PreparedFixture> {
  const fixture = releaseUiDebugFixture(fixtureId);
  if (!fixture) throw new Error(`UI debug fixture ${fixtureId} is not registered`);
  if (fixture.setup.kind === "app-state") {
    const appSetup = fixture.setup;
    const baseline = await apiJson<AppUiBaseline>(connection, "GET", "/state/ui");
    let settingsTabBaseline: string | null = null;
    let sessionFixture: DebugApiSessionFixture | null = null;
    let vaultDirectoryBaseline: VaultDirectory | null = null;
    let vaultLifecyclePrepared = false;
    let ownedCwdPicker: OwnedCwdPicker | null = null;
    let ownedGitRepo: OwnedGitRepo | null = null;
    let ownedConnectionPreset: OwnedConnectionPreset | null = null;
    let ownedFilesPane: OwnedFilesPane | null = null;
    let ownedPreviewFile: OwnedPreviewFile | null = null;
    let ownedPendingAttachment: OwnedPendingAttachment | null = null;
    let ownedRendererEventProjection: OwnedRendererEventProjection | null = null;
    let ownedActivityBrowser: ActivityFixture | null = null;
    let ownedVaultAgentRequest: OwnedVaultAgentRequest | null = null;
    let ownedVaultGrant: OwnedVaultGrant | null = null;
    let ownedWorkPreviewIssue: OwnedWorkPreviewIssue | null = null;
    let fixtureSetupStarted = false;
    try {
      if (appSetup.ownedSessionHistory || appSetup.ownedSessionHistorySurface) {
        sessionFixture = prepareDebugApiSessionFixture(request, "ui_find");
      }
      if (appSetup.ownedVaultSecret) {
        vaultDirectoryBaseline = await prepareOwnedVaultSecret(connection, appSetup.ownedVaultSecret);
      }
      if (appSetup.ownedVaultLifecycle) {
        await prepareOwnedVaultLifecycle(connection, appSetup.ownedVaultLifecycle);
        vaultLifecyclePrepared = true;
      }
      if (appSetup.ownedCwdPicker) {
        ownedCwdPicker = prepareOwnedCwdPicker(appSetup.ownedCwdPicker, request);
      }
      if (appSetup.ownedGitRepo) {
        ownedGitRepo = prepareOwnedGitRepo(request);
      }
      if (appSetup.ownedConnectionPreset) {
        ownedConnectionPreset = await prepareOwnedConnectionPreset(connection, request);
      }
      if (appSetup.ownedFilesPane) {
        ownedFilesPane = prepareOwnedFilesPane(request);
      }
      if (appSetup.ownedPreviewFile) {
        ownedPreviewFile = prepareOwnedPreviewFile(request, appSetup.ownedPreviewFile);
      }
      if (appSetup.ownedPendingAttachment) {
        ownedPendingAttachment = prepareOwnedPendingAttachment(request);
      }
      if (appSetup.ownedRendererEventProjection) {
        ownedRendererEventProjection = prepareOwnedRendererEventProjection(request);
      }
      if (appSetup.ownedActivityBrowser) {
        ownedActivityBrowser = prepareActivityFixture(request);
      }
      if (appSetup.ownedVaultAgentRequest) {
        ownedVaultAgentRequest = await prepareOwnedVaultAgentRequest(connection, request);
      }
      if (appSetup.ownedVaultGrant) {
        ownedVaultGrant = await prepareOwnedVaultGrant(connection, request);
      }
      if (appSetup.ownedWorkPreviewIssue) {
        ownedWorkPreviewIssue = await prepareOwnedWorkPreviewIssue(connection, request, baseline);
      }
      await postUi(connection, "app", {
        openModal: "close",
        composerMenu: "close",
        cwdPicker: { open: false },
        vaultRequestCenterOpen: false,
        debugHighlights: [],
      });
      if (appSetup.cleanupAbsentSelector) {
        await waitForSelectorAbsent(
          connection,
          "app",
          appSetup.cleanupAbsentSelector,
          "app fixture owned baseline",
        );
      }
      if (appSetup.cleanupAfterRestoreAbsentSelector) {
        await waitForSelectorAbsent(
          connection,
          "app",
          appSetup.cleanupAfterRestoreAbsentSelector,
          "app fixture restored baseline",
        );
      }
      fixtureSetupStarted = true;
      if (ownedWorkPreviewIssue) {
        await startOwnedWorkPreviewIssue(connection, ownedWorkPreviewIssue);
      }
      const fixturePatch: Record<string, unknown> = { ...appSetup.patch };
      if (ownedCwdPicker) {
        fixturePatch.cwdPicker = { path: ownedCwdPicker.pickerPath, label: ownedCwdPicker.label };
      }
      if (ownedGitRepo) {
        const baselineTabId = baseline.activeTab?.tabId;
        const tabId = baseline.activeTabId
          ?? (typeof baselineTabId === "string" ? baselineTabId : null);
        if (!tabId) throw new Error("owned Git fixture requires one active renderer tab");
        fixturePatch.activeTab = {
          ...(baseline.activeTab ?? {}),
          tabId,
          cwd: ownedGitRepo.repoPath,
          connectionId: null,
          connectionLabel: "Local",
          connectionTransport: "local",
        };
      }
      if (ownedFilesPane) {
        const baselineTabId = baseline.activeTab?.tabId;
        const tabId = baseline.activeTabId
          ?? (typeof baselineTabId === "string" ? baselineTabId : null);
        if (!tabId) throw new Error("owned Files fixture requires one active renderer tab");
        fixturePatch.activeTab = {
          ...(baseline.activeTab ?? {}),
          tabId,
          cwd: ownedFilesPane.directoryPath,
          connectionId: null,
          connectionLabel: "Local",
          connectionTransport: "local",
        };
      }
      if (ownedPreviewFile) {
        fixturePatch.preview = { path: ownedPreviewFile.filePath, kind: "file" };
      }
      if (ownedPendingAttachment) {
        fixturePatch.debugAttachPaths = [ownedPendingAttachment.filePath];
      }
      if (ownedRendererEventProjection) {
        fixturePatch.debugRendererFixture = {
          id: "event-projections",
          attachmentPath: ownedRendererEventProjection.attachmentPath,
          imagePath: ownedRendererEventProjection.imagePath,
          videoPath: ownedRendererEventProjection.videoPath,
        };
      }
      if (ownedActivityBrowser) {
        const baselineTabId = baseline.activeTab?.tabId;
        const tabId = baseline.activeTabId
          ?? (typeof baselineTabId === "string" ? baselineTabId : null);
        if (!tabId) throw new Error("owned Activity Browser fixture requires one active renderer tab");
        fixturePatch.activeTab = {
          ...(baseline.activeTab ?? {}),
          tabId,
          sessionId: ownedActivityBrowser.id,
          cwd: ownedActivityBrowser.cwd,
          connectionId: null,
          connectionLabel: "Local",
          connectionTransport: "local",
        };
      }
      if (ownedWorkPreviewIssue) {
        fixturePatch.activeTabId = ownedWorkPreviewIssue.tabId;
        fixturePatch.activeTab = {
          ...(baseline.activeTab ?? {}),
          tabId: ownedWorkPreviewIssue.tabId,
          cwd: ownedWorkPreviewIssue.launchRoot,
          connectionId: null,
          connectionLabel: "Local",
          connectionTransport: "local",
        };
        fixturePatch.rightTab = "Preview";
      }
      await postUi(connection, "app", fixturePatch);
      await delay(250);
      if (appSetup.preserveSettingsTab) {
        settingsTabBaseline = await detectActiveSettingsTab(connection);
      }
      await runPatchSteps(connection, "app", appSetup.steps);
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (fixtureSetupStarted) {
        try {
          if (appSetup.cleanupReadySelector) {
            await waitForSelectorResolved(
              connection,
              "app",
              appSetup.cleanupReadySelector,
              "app fixture setup cleanup readiness",
            );
          }
          await runPatchSteps(connection, "app", appSetup.cleanupSteps);
          if (ownedPendingAttachment) {
            await removeOwnedPendingAttachment(connection, ownedPendingAttachment);
          }
          if (appSetup.cleanupAbsentSelector) {
            await waitForSelectorAbsent(
              connection,
              "app",
              appSetup.cleanupAbsentSelector,
              "app fixture setup cleanup",
            );
          }
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      try {
        await cleanupAppFixture(connection, baseline, settingsTabBaseline);
        if (appSetup.cleanupAfterRestoreAbsentSelector) {
          await waitForSelectorAbsent(
            connection,
            "app",
            appSetup.cleanupAfterRestoreAbsentSelector,
            "app fixture restored cleanup",
          );
        }
      } catch (cleanupError) {
        cleanupErrors.push(errorMessage(cleanupError));
      }
      if (appSetup.ownedVaultSecret && vaultDirectoryBaseline) {
        try {
          await cleanupOwnedVaultSecret(connection, appSetup.ownedVaultSecret.key, vaultDirectoryBaseline);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (vaultLifecyclePrepared) {
        try {
          await cleanupOwnedVaultLifecycle(connection);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (sessionFixture) {
        const sessionCleanupError = await cleanupOwnedSessionHistory(
          connection,
          sessionFixture,
          appSetup.ownedSessionHistorySurface === true,
        );
        if (sessionCleanupError) cleanupErrors.push(sessionCleanupError);
      }
      if (ownedCwdPicker) {
        const cwdCleanupError = cleanupOwnedCwdPicker(ownedCwdPicker);
        if (cwdCleanupError) cleanupErrors.push(cwdCleanupError);
      }
      if (ownedGitRepo) {
        const gitCleanupError = cleanupOwnedGitRepo(ownedGitRepo);
        if (gitCleanupError) cleanupErrors.push(gitCleanupError);
      }
      if (ownedConnectionPreset) {
        try {
          await cleanupOwnedConnectionPreset(connection, ownedConnectionPreset);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (ownedFilesPane) {
        const filesCleanupError = cleanupOwnedFilesPane(ownedFilesPane);
        if (filesCleanupError) cleanupErrors.push(filesCleanupError);
      }
      if (ownedPreviewFile) {
        const previewCleanupError = cleanupOwnedPreviewFile(ownedPreviewFile);
        if (previewCleanupError) cleanupErrors.push(previewCleanupError);
      }
      if (ownedPendingAttachment) {
        const attachmentCleanupError = cleanupOwnedPendingAttachment(ownedPendingAttachment);
        if (attachmentCleanupError) cleanupErrors.push(attachmentCleanupError);
      }
      if (ownedRendererEventProjection) {
        const rendererCleanupError = cleanupOwnedRendererEventProjection(ownedRendererEventProjection);
        if (rendererCleanupError) cleanupErrors.push(rendererCleanupError);
      }
      if (ownedActivityBrowser) {
        try {
          cleanupActivityFixture(ownedActivityBrowser);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (ownedVaultAgentRequest) {
        try {
          await cleanupOwnedVaultAgentRequest(connection, ownedVaultAgentRequest);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (ownedVaultGrant) {
        try {
          await cleanupOwnedVaultGrant(connection, ownedVaultGrant);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (ownedWorkPreviewIssue) {
        try {
          await cleanupOwnedWorkPreviewIssue(connection, ownedWorkPreviewIssue);
        } catch (cleanupError) {
          cleanupErrors.push(errorMessage(cleanupError));
        }
      }
      if (cleanupErrors.length > 0) throw new Error(`${errorMessage(error)}; setup cleanup: ${cleanupErrors.join("; ")}`);
      throw error;
    }
    return {
      debugSurface: "app",
      cleanup: async () => {
        const cleanupErrors: string[] = [];
        try {
          if (appSetup.cleanupReadySelector) {
            await waitForSelectorResolved(
              connection,
              "app",
              appSetup.cleanupReadySelector,
              "app fixture cleanup readiness",
            );
          }
          await runPatchSteps(connection, "app", appSetup.cleanupSteps);
          if (ownedPendingAttachment) {
            await removeOwnedPendingAttachment(connection, ownedPendingAttachment);
          }
          if (appSetup.cleanupAbsentSelector) {
            await waitForSelectorAbsent(
              connection,
              "app",
              appSetup.cleanupAbsentSelector,
              "app fixture cleanup",
            );
          }
        } catch (error) {
          cleanupErrors.push(errorMessage(error));
        }
        try {
          await cleanupAppFixture(connection, baseline, settingsTabBaseline);
          if (appSetup.cleanupAfterRestoreAbsentSelector) {
            await waitForSelectorAbsent(
              connection,
              "app",
              appSetup.cleanupAfterRestoreAbsentSelector,
              "app fixture restored cleanup",
            );
          }
        } catch (error) {
          cleanupErrors.push(errorMessage(error));
        }
        if (appSetup.ownedVaultSecret && vaultDirectoryBaseline) {
          try {
            await cleanupOwnedVaultSecret(connection, appSetup.ownedVaultSecret.key, vaultDirectoryBaseline);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
        if (vaultLifecyclePrepared) {
          try {
            await cleanupOwnedVaultLifecycle(connection);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
        if (sessionFixture) {
          const sessionCleanupError = await cleanupOwnedSessionHistory(
            connection,
            sessionFixture,
            appSetup.ownedSessionHistorySurface === true,
          );
          if (sessionCleanupError) cleanupErrors.push(sessionCleanupError);
        }
        if (ownedCwdPicker) {
          const cwdCleanupError = cleanupOwnedCwdPicker(ownedCwdPicker);
          if (cwdCleanupError) cleanupErrors.push(cwdCleanupError);
        }
        if (ownedGitRepo) {
          const gitCleanupError = cleanupOwnedGitRepo(ownedGitRepo);
          if (gitCleanupError) cleanupErrors.push(gitCleanupError);
        }
        if (ownedConnectionPreset) {
          try {
            await cleanupOwnedConnectionPreset(connection, ownedConnectionPreset);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
        if (ownedFilesPane) {
          const filesCleanupError = cleanupOwnedFilesPane(ownedFilesPane);
          if (filesCleanupError) cleanupErrors.push(filesCleanupError);
        }
        if (ownedPreviewFile) {
          const previewCleanupError = cleanupOwnedPreviewFile(ownedPreviewFile);
          if (previewCleanupError) cleanupErrors.push(previewCleanupError);
        }
        if (ownedPendingAttachment) {
          const attachmentCleanupError = cleanupOwnedPendingAttachment(ownedPendingAttachment);
          if (attachmentCleanupError) cleanupErrors.push(attachmentCleanupError);
        }
        if (ownedRendererEventProjection) {
          const rendererCleanupError = cleanupOwnedRendererEventProjection(ownedRendererEventProjection);
          if (rendererCleanupError) cleanupErrors.push(rendererCleanupError);
        }
        if (ownedActivityBrowser) {
          try {
            cleanupActivityFixture(ownedActivityBrowser);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
        if (ownedVaultAgentRequest) {
          try {
            await cleanupOwnedVaultAgentRequest(connection, ownedVaultAgentRequest);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
        if (ownedVaultGrant) {
          try {
            await cleanupOwnedVaultGrant(connection, ownedVaultGrant);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
        if (ownedWorkPreviewIssue) {
          try {
            await cleanupOwnedWorkPreviewIssue(connection, ownedWorkPreviewIssue);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
        if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
      },
    };
  }

  const browserSetup = fixture.setup;
  let taskId: string | null = null;
  let ownedBrowserMissingRecipe: OwnedBrowserMissingRecipe | null = null;
  try {
    const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
      goal: `Final surface UI debug addressability fixture ${fixtureId}`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    await postUi(connection, "browser", {
      rightTab: browserSetup.rightTab,
      debugHighlights: [],
    });
    await delay(350);
    if (browserSetup.ownedDownloadIntent) {
      await prepareOwnedBrowserDownloadIntent(connection, taskId);
    }
    ownedBrowserMissingRecipe = await prepareOwnedBookmarks(
      connection,
      browserSetup.ownedBookmarks,
      request,
    );
    await runPatchSteps(connection, "browser", browserSetup.steps);
  } catch (error) {
    if (taskId) {
      try {
        await cleanupOwnedBrowserFixture(
          connection,
          taskId,
          browserSetup,
          ownedBrowserMissingRecipe,
        );
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)}; setup cleanup: ${errorMessage(cleanupError)}`);
      }
    }
    throw error;
  }
  return {
    debugSurface: "browser",
    cleanup: () => cleanupOwnedBrowserFixture(
      connection,
      taskId as string,
      browserSetup,
      ownedBrowserMissingRecipe,
    ),
  };
}

async function prepareOwnedBrowserDownloadIntent(
  connection: Connection,
  taskId: string,
): Promise<void> {
  const state = await apiJson<Record<string, unknown>>(connection, "GET", "/browser/state");
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const tab = tabs.find((value) => {
    const row = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    return row?.taskId === taskId && typeof row.browserTabId === "string" && row.browserTabId.length > 0;
  }) as Record<string, unknown> | undefined;
  const browserTabId = requiredString(tab?.browserTabId, "owned Browser download badge tabId");
  const transfer = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/downloads/request", {
    taskId,
    browserTabId,
    url: "https://example.invalid/shellx-release-owned-download.txt",
    fileName: "shellx-release-owned-download.txt",
    reason: "Final surface Browser download badge proof",
  });
  if (transfer.direction !== "download" || transfer.status !== "requested"
    || transfer.taskId !== taskId || transfer.browserTabId !== browserTabId
    || typeof transfer.transferId !== "string" || !transfer.transferId) {
    throw new Error("owned Browser download badge fixture omitted its exact requested intent identity");
  }
}

function prepareOwnedCwdPicker(
  mode: "empty" | "with-child",
  request: ReleaseSurfaceDriverRequest,
): OwnedCwdPicker {
  const commitSegment = request.sourceCommit.slice(0, 12).replace(/[^a-f0-9]/gi, "0");
  const rootPath = mkdtempSync(join(tmpdir(), `shellx-release-ui-cwd-${mode}-${commitSegment}-`));
  try {
    const pickerPath = join(rootPath, mode === "empty" ? "empty" : "listing");
    mkdirSync(pickerPath, { mode: 0o700 });
    if (mode === "with-child") mkdirSync(join(pickerPath, "owned-child"), { mode: 0o700 });
    return {
      rootPath,
      pickerPath,
      label: mode === "empty" ? "Final surface owned empty folder" : "Final surface owned folder with child",
    };
  } catch (error) {
    if (existsSync(rootPath)) rmSync(rootPath, { recursive: true });
    throw error;
  }
}

function cleanupOwnedCwdPicker(owned: OwnedCwdPicker): string | null {
  try {
    if (existsSync(owned.rootPath)) rmSync(owned.rootPath, { recursive: true });
    if (existsSync(owned.rootPath)) throw new Error("owned cwd picker tree remained after deletion");
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function prepareOwnedGitRepo(request: ReleaseSurfaceDriverRequest): OwnedGitRepo {
  const commitSegment = request.sourceCommit.slice(0, 12).replace(/[^a-f0-9]/gi, "0");
  const rootPath = mkdtempSync(join(tmpdir(), `shellx-release-ui-git-${commitSegment}-`));
  const repoPath = join(rootPath, "repo");
  try {
    mkdirSync(repoPath, { mode: 0o700 });
    runOwnedGit(repoPath, ["init", "--quiet"]);
    runOwnedGit(repoPath, ["config", "user.name", "ShellX Release Fixture"]);
    runOwnedGit(repoPath, ["config", "user.email", "release-fixture@invalid.example"]);
    runOwnedGit(repoPath, ["commit", "--quiet", "--allow-empty", "-m", "owned release fixture"]);
    return { rootPath, repoPath };
  } catch (error) {
    if (existsSync(rootPath)) rmSync(rootPath, { recursive: true });
    throw error;
  }
}

function runOwnedGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`owned Git fixture failed: git ${args[0]}: ${result.stderr || result.error?.message || "unknown error"}`);
  }
}

function cleanupOwnedGitRepo(owned: OwnedGitRepo): string | null {
  try {
    if (existsSync(owned.rootPath)) rmSync(owned.rootPath, { recursive: true });
    if (existsSync(owned.rootPath)) throw new Error("owned Git repository remained after deletion");
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function prepareOwnedFilesPane(request: ReleaseSurfaceDriverRequest): OwnedFilesPane {
  const commitSegment = request.sourceCommit.slice(0, 12).replace(/[^a-f0-9]/gi, "0");
  const rootPath = mkdtempSync(join(tmpdir(), `shellx-release-ui-files-${commitSegment}-`));
  const directoryPath = join(rootPath, "directory");
  try {
    mkdirSync(directoryPath, { mode: 0o700 });
    writeFileSync(join(directoryPath, "owned-file.txt"), "ShellX owned release fixture\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { rootPath, directoryPath };
  } catch (error) {
    if (existsSync(rootPath)) rmSync(rootPath, { recursive: true });
    throw error;
  }
}

function cleanupOwnedFilesPane(owned: OwnedFilesPane): string | null {
  try {
    if (existsSync(owned.rootPath)) rmSync(owned.rootPath, { recursive: true });
    if (existsSync(owned.rootPath)) throw new Error("owned Files fixture remained after deletion");
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function prepareOwnedPreviewFile(
  request: ReleaseSurfaceDriverRequest,
  kind: "video" | "markdown",
): OwnedPreviewFile {
  const commitSegment = request.sourceCommit.slice(0, 12).replace(/[^a-f0-9]/gi, "0");
  const rootPath = mkdtempSync(join(tmpdir(), `shellx-release-ui-preview-${commitSegment}-`));
  const filePath = join(rootPath, kind === "video" ? "owned-preview.mp4" : "owned-preview.md");
  try {
    if (kind === "video") {
      const minimalMp4Ftyp = Buffer.from("AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==", "base64");
      writeFileSync(filePath, minimalMp4Ftyp, { flag: "wx", mode: 0o600 });
    } else {
      writeFileSync(join(rootPath, "owned-target.txt"), "ShellX owned Markdown target\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(
        filePath,
        "# ShellX owned Markdown preview\n\n[Owned target](./owned-target.txt)\n\n[HTTPS reference](https://example.com/)\n",
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }
    return { rootPath, filePath };
  } catch (error) {
    if (existsSync(rootPath)) rmSync(rootPath, { recursive: true });
    throw error;
  }
}

function cleanupOwnedPreviewFile(owned: OwnedPreviewFile): string | null {
  try {
    if (existsSync(owned.rootPath)) rmSync(owned.rootPath, { recursive: true });
    if (existsSync(owned.rootPath)) throw new Error("owned Preview fixture remained after deletion");
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

async function prepareOwnedWorkPreviewIssue(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
  baseline: AppUiBaseline,
): Promise<OwnedWorkPreviewIssue> {
  const baselineTabId = baseline.activeTab?.tabId;
  const tabId = baseline.activeTabId
    ?? (typeof baselineTabId === "string" ? baselineTabId : null);
  if (!tabId) throw new Error("owned Work Preview issue fixture requires one active renderer tab");
  const idle = await workPreviewState(connection, tabId);
  if (idle.tabId !== tabId || idle.status !== "idle" || idle.url !== null) {
    throw new Error("owned Work Preview issue fixture refuses to replace an existing preview lifecycle");
  }

  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) {
    throw new Error("owned Work Preview issue fixture requires a regular non-link Debug token");
  }
  if (basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("owned Work Preview issue fixture requires the installed candidate's .shellx token path");
  }
  const nodeProfileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfileRoot, "ui-work-preview-debug-issue");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("owned Work Preview issue fixture escaped the disposable profile");
  }
  if (existsSync(nodeRoot)) throw new Error("owned Work Preview issue fixture root must not pre-exist");
  mkdirSync(nodeRoot, { mode: 0o700 });
  try {
    writeFileSync(join(nodeRoot, WORK_PREVIEW_ISSUE_ENTRY), WORK_PREVIEW_ISSUE_PAGE, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (existsSync(nodeRoot)) rmSync(nodeRoot, { recursive: true });
    throw error;
  }
  const launchProfileRoot = portableParent(
    portableParent(request.runtime.debugTokenPath, request.platform),
    request.platform,
  );
  return {
    nodeRoot,
    launchRoot: portableJoin(launchProfileRoot, "ui-work-preview-debug-issue", request.platform),
    tabId,
    url: null,
  };
}

async function startOwnedWorkPreviewIssue(
  connection: Connection,
  owned: OwnedWorkPreviewIssue,
): Promise<void> {
  let running = await apiJson<Record<string, unknown>>(
    connection,
    "POST",
    `/preview/work/start?tabId=${encodeURIComponent(owned.tabId)}`,
    {
      tabId: owned.tabId,
      cwd: owned.launchRoot,
      kind: "static",
      entry: WORK_PREVIEW_ISSUE_ENTRY,
    },
  );
  const deadline = Date.now() + 30_000;
  while (running.status !== "running" && Date.now() < deadline) {
    if (running.status === "failed") {
      throw new Error(`owned Work Preview issue fixture failed: ${String(running.error ?? "unknown error")}`);
    }
    await delay(50);
    running = await workPreviewState(connection, owned.tabId);
  }
  const url = typeof running.url === "string" ? running.url : "";
  if (running.tabId !== owned.tabId || running.status !== "running"
    || running.cwd !== owned.launchRoot || running.kind !== "staticHtml"
    || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
    throw new Error("owned Work Preview issue fixture returned the wrong running state");
  }
  const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!page.ok || !(await page.text()).includes(WORK_PREVIEW_ISSUE_MARKER)) {
    throw new Error("owned Work Preview issue fixture did not serve its exact warning page");
  }
  owned.url = url;
}

async function cleanupOwnedWorkPreviewIssue(
  connection: Connection,
  owned: OwnedWorkPreviewIssue,
): Promise<void> {
  const errors: string[] = [];
  try {
    const before = await workPreviewState(connection, owned.tabId);
    const oldUrl = typeof before.url === "string" ? before.url : owned.url;
    if (before.status !== "idle") {
      const stopped = await apiJson<Record<string, unknown>>(
        connection,
        "POST",
        `/preview/work/stop?tabId=${encodeURIComponent(owned.tabId)}`,
        { tabId: owned.tabId },
      );
      if (stopped.tabId !== owned.tabId || !["idle", "stopped"].includes(String(stopped.status))
        || stopped.url !== null) {
        throw new Error("owned Work Preview issue cleanup returned the wrong stopped state");
      }
    }
    if (oldUrl) await waitForPreviewUnavailable(oldUrl);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    if (existsSync(owned.nodeRoot)) rmSync(owned.nodeRoot, { recursive: true });
    if (existsSync(owned.nodeRoot)) throw new Error("owned Work Preview issue fixture root remained");
  } catch (error) {
    errors.push(errorMessage(error));
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

async function workPreviewState(
  connection: Connection,
  tabId: string,
): Promise<Record<string, unknown>> {
  return apiJson(connection, "GET", `/preview/work/state?tabId=${encodeURIComponent(tabId)}`);
}

async function waitForPreviewUnavailable(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (!response.ok) return;
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error("owned Work Preview issue endpoint remained reachable after stop");
}

function nodeReadablePath(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("unable to map the owned Work Preview issue token path");
  }
  return resolve(result.stdout.trim());
}

function portableParent(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("owned Work Preview issue token path is outside a disposable profile");
  return normalized.slice(0, index);
}

function portableJoin(
  base: string,
  child: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
}

function prepareOwnedPendingAttachment(request: ReleaseSurfaceDriverRequest): OwnedPendingAttachment {
  const commitSegment = request.sourceCommit.slice(0, 12).replace(/[^a-f0-9]/gi, "0");
  const rootPath = mkdtempSync(join(tmpdir(), `shellx-release-ui-attachment-${commitSegment}-`));
  const filePath = join(rootPath, "owned-attachment.txt");
  try {
    writeFileSync(filePath, "ShellX owned pending attachment\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { rootPath, filePath };
  } catch (error) {
    if (existsSync(rootPath)) rmSync(rootPath, { recursive: true });
    throw error;
  }
}

async function removeOwnedPendingAttachment(
  connection: Connection,
  owned: OwnedPendingAttachment,
): Promise<void> {
  await postUi(connection, "app", { debugRemoveAttachmentPaths: [owned.filePath] });
  await delay(150);
}

function cleanupOwnedPendingAttachment(owned: OwnedPendingAttachment): string | null {
  try {
    if (existsSync(owned.rootPath)) rmSync(owned.rootPath, { recursive: true });
    if (existsSync(owned.rootPath)) throw new Error("owned pending attachment fixture remained after deletion");
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function prepareOwnedRendererEventProjection(
  request: ReleaseSurfaceDriverRequest,
): OwnedRendererEventProjection {
  const commitSegment = request.sourceCommit.slice(0, 12).replace(/[^a-f0-9]/gi, "0");
  const rootPath = mkdtempSync(join(tmpdir(), `shellx-release-ui-events-${commitSegment}-`));
  const attachmentPath = join(rootPath, "owned-event-attachment.txt");
  const imagePath = join(rootPath, "owned-event-image.png");
  const videoPath = join(rootPath, "owned-event-video.mp4");
  try {
    writeFileSync(attachmentPath, "ShellX owned renderer event attachment\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      imagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      videoPath,
      Buffer.from("AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==", "base64"),
      { flag: "wx", mode: 0o600 },
    );
    return { rootPath, attachmentPath, imagePath, videoPath };
  } catch (error) {
    if (existsSync(rootPath)) rmSync(rootPath, { recursive: true });
    throw error;
  }
}

function cleanupOwnedRendererEventProjection(owned: OwnedRendererEventProjection): string | null {
  try {
    if (existsSync(owned.rootPath)) rmSync(owned.rootPath, { recursive: true });
    if (existsSync(owned.rootPath)) throw new Error("owned renderer event fixture remained after deletion");
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

async function prepareOwnedVaultAgentRequest(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
): Promise<OwnedVaultAgentRequest> {
  const segment = request.sourceCommit.slice(0, 16);
  const actorId = `shellx-release-ui-${segment}`;
  const secretRef = `release-ui/agent-request/${segment}`;
  const secretValue = `SHELLX_RELEASE_UI_AGENT_REQUEST_${request.sourceCommit}`;
  await cleanupOwnedVaultLifecycle(connection);
  await verifyEmptyOwnedVaultAgentRequests(connection);
  try {
    await apiJson(connection, "POST", "/vault/set", {
      key: secretRef,
      value: secretValue,
      description: "Disposable release UI agent-request resource",
      userOnly: false,
    });
    const response = await apiJson<Record<string, unknown>>(connection, "POST", "/vault/agent-requests", {
      actorId,
      actorLabel: `ShellX release UI ${segment}`,
      spec: {
        purpose: `Render owned Vault request ${segment}`,
        program: request.runtime.installedPayloadPath,
        args: [],
        cwd: null,
        bindings: [{
          resourceId: secretRef,
          field: "value",
          env: "SHELLX_RELEASE_UI_VAULT_TOKEN",
        }],
        timeoutMs: 5_000,
      },
    });
    if (JSON.stringify(response).includes(secretValue)) {
      throw new Error("owned Vault agent-request response exposed its secret value");
    }
    const row = response.request;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("owned Vault agent-request response omitted its request row");
    }
    const requestId = requiredString((row as Record<string, unknown>).requestId, "owned Vault request id");
    if (response.ok !== true || response.status !== "pendingOperatorApproval"
      || response.secretExposed !== false || (row as Record<string, unknown>).actorId !== actorId
      || (row as Record<string, unknown>).status !== "pending") {
      throw new Error("owned Vault agent-request did not enter its exact pending state");
    }
    return { actorId, requestId };
  } catch (error) {
    try {
      await cleanupOwnedVaultLifecycle(connection);
      await verifyEmptyOwnedVaultAgentRequests(connection);
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; owned Vault request setup cleanup: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

async function cleanupOwnedVaultAgentRequest(
  connection: Connection,
  owned: OwnedVaultAgentRequest,
): Promise<void> {
  const snapshot = await apiJson<Record<string, unknown>>(
    connection,
    "GET",
    `/vault/agent-requests?actorId=${encodeURIComponent(owned.actorId)}`,
  );
  const rows = Array.isArray(snapshot.requests) ? snapshot.requests : [];
  const pending = rows.some((row) => (
    row && typeof row === "object" && !Array.isArray(row)
    && (row as Record<string, unknown>).requestId === owned.requestId
    && (row as Record<string, unknown>).status === "pending"
  ));
  if (pending) {
    await apiJson(
      connection,
      "POST",
      `/vault/agent-requests/${encodeURIComponent(owned.requestId)}/cancel`,
      { actorId: owned.actorId },
    );
  }
  await cleanupOwnedVaultLifecycle(connection);
  await verifyEmptyOwnedVaultAgentRequests(connection);
}

async function verifyEmptyOwnedVaultAgentRequests(connection: Connection): Promise<void> {
  const snapshot = await apiJson<Record<string, unknown>>(connection, "GET", "/vault/agent-requests");
  if (snapshot.pendingCount !== 0
    || !Array.isArray(snapshot.requests) || snapshot.requests.length !== 0
    || !Array.isArray(snapshot.resources) || snapshot.resources.length !== 0) {
    throw new Error("owned Vault agent-request baseline retained request or resource metadata");
  }
}

async function prepareOwnedVaultGrant(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
): Promise<OwnedVaultGrant> {
  const segment = request.sourceCommit.slice(0, 16);
  const secretRef = `release-ui/grant/${segment}`;
  const secretValue = `SHELLX_RELEASE_UI_GRANT_${request.sourceCommit}`;
  await cleanupOwnedVaultLifecycle(connection);
  await verifyEmptyOwnedVaultGrants(connection);
  try {
    const seeded = await apiJson<Record<string, unknown>>(connection, "POST", "/vault/e2e/seed-secret", {
      secretRef,
      value: secretValue,
    });
    if (seeded.ok !== true || seeded.secretRef !== secretRef || seeded.secretPresent !== true
      || seeded.secretExposed !== false || JSON.stringify(seeded).includes(secretValue)) {
      throw new Error("owned Vault grant secret seed was not exact and redacted");
    }
    const approved = await apiJson<Record<string, unknown>>(connection, "POST", "/vault/e2e/approve-grant", {
      secretRef,
      actorScope: { kind: "allShellxAgents" },
      operation: "fill",
      origin: "https://example.com",
      expiresAtMs: Date.now() + 10 * 60_000,
    });
    if (JSON.stringify(approved).includes(secretValue)) {
      throw new Error("owned Vault grant approval exposed its secret value");
    }
    const grant = approved.grant;
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
      throw new Error("owned Vault grant approval omitted its grant row");
    }
    const grantRow = grant as Record<string, unknown>;
    const grantId = requiredString(grantRow.grantId, "owned Vault grant id");
    if (approved.ok !== true || approved.secretExposed !== false
      || grantRow.secretRef !== secretRef || grantRow.approved !== true || grantRow.revoked !== false
      || grantRow.origin !== "https://example.com" || grantRow.operation !== "Fill") {
      throw new Error("owned Vault grant did not enter its exact active state");
    }
    return { grantId };
  } catch (error) {
    try {
      await cleanupOwnedVaultLifecycle(connection);
      await verifyEmptyOwnedVaultGrants(connection);
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; owned Vault grant setup cleanup: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

async function cleanupOwnedVaultGrant(
  connection: Connection,
  _owned: OwnedVaultGrant,
): Promise<void> {
  await cleanupOwnedVaultLifecycle(connection);
  await verifyEmptyOwnedVaultGrants(connection);
}

async function verifyEmptyOwnedVaultGrants(connection: Connection): Promise<void> {
  const directory = await apiJson<Record<string, unknown>>(connection, "GET", "/vault/grants");
  if (!Array.isArray(directory.grants) || directory.grants.length !== 0) {
    throw new Error("owned Vault grant baseline retained grant metadata");
  }
}

async function prepareOwnedConnectionPreset(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
): Promise<OwnedConnectionPreset> {
  const label = `ShellX final owned connection ${request.sourceCommit.slice(0, 16)}`;
  const baseline = await apiJson<{ presets?: unknown[] }>(connection, "GET", "/connections");
  const baselinePresets = Array.isArray(baseline.presets) ? baseline.presets : [];
  if (baselinePresets.some((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Record<string, unknown>).label === label
  ))) {
    throw new Error("owned connection preset already existed before setup");
  }
  let id: string | null = null;
  try {
    const saved = await apiJson<Record<string, unknown>>(connection, "POST", "/connections", {
      id: "",
      label,
    transport: { kind: "local" },
    createdMs: 0,
    lastUsedMs: 0,
    providerScan: [{
      providerId: "codex-cli",
      canRun: true,
      status: "ready",
      binary: "shellx-release-codex-fixture",
      version: "codex-fixture 0.0.0",
      binarySha256: "a".repeat(64),
      binaryBytes: 1,
      targetKey: "release-fixture",
      detail: "Owned release fixture; no provider process is launched.",
      checkedAtMs: 1_000,
    }],
    });
    id = requiredString(saved.id, "owned connection preset id");
    const changed = await apiJson<{ presets?: unknown[] }>(connection, "GET", "/connections");
    const changedPresets = Array.isArray(changed.presets) ? changed.presets : [];
    if (!changedPresets.some((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).id === id
      && (entry as Record<string, unknown>).label === label
    ))) {
      throw new Error("owned connection preset was not persisted exactly");
    }
    return { id, baselineJson: JSON.stringify(baseline) };
  } catch (error) {
    try {
      const current = await apiJson<{ presets?: unknown[] }>(connection, "GET", "/connections");
      const match = (Array.isArray(current.presets) ? current.presets : []).find((entry) => (
        entry && typeof entry === "object" && !Array.isArray(entry)
        && (entry as Record<string, unknown>).label === label
      ));
      const cleanupId = id ?? (match && typeof match === "object"
        ? (match as Record<string, unknown>).id
        : null);
      if (typeof cleanupId === "string") {
        await cleanupOwnedConnectionPreset(connection, {
          id: cleanupId,
          baselineJson: JSON.stringify(baseline),
        });
      } else if (JSON.stringify(current) !== JSON.stringify(baseline)) {
        throw new Error("connection directory changed without an identifiable owned preset");
      }
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; setup cleanup: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

async function cleanupOwnedConnectionPreset(
  connection: Connection,
  owned: OwnedConnectionPreset,
): Promise<void> {
  const response = await fetch(`${connection.base}/connections/${encodeURIComponent(owned.id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  if (response.status !== 204) {
    throw new Error(`owned connection preset deletion returned ${response.status}`);
  }
  const restored = await apiJson<{ presets?: unknown[] }>(connection, "GET", "/connections");
  if (JSON.stringify(restored) !== owned.baselineJson) {
    throw new Error("connection preset directory was not restored byte-for-byte");
  }
}

async function cleanupAppFixture(
  connection: Connection,
  baseline: AppUiBaseline,
  settingsTabBaseline: string | null,
): Promise<void> {
  if (settingsTabBaseline) {
    await postUi(connection, "app", {
      debugClick: `[data-debug-id='settings-tab-${settingsTabBaseline}']`,
    });
    await delay(200);
    await waitForSelectorResolved(
      connection,
      "app",
      `[data-debug-id='settings-tab-${settingsTabBaseline}'][aria-selected='true']`,
      "settings tab restoration",
    );
  }
  await postUi(connection, "app", {
    openModal: "close",
    composerMenu: "close",
    cwdPicker: { open: false },
    vaultRequestCenterOpen: false,
    debugHighlights: [],
    ...(baseline.bottomTab ? { bottomTab: baseline.bottomTab } : {}),
    ...(baseline.rightTab ? { rightTab: baseline.rightTab } : {}),
    ...(typeof baseline.setupGuideDismissed === "boolean"
      ? { setupGuideDismissed: baseline.setupGuideDismissed }
      : {}),
    ...(baseline.activeTab ? { activeTab: baseline.activeTab } : {}),
  });
  await delay(100);
}

async function cleanupOwnedSessionHistory(
  connection: Connection,
  fixture: DebugApiSessionFixture,
  refreshPastChats: boolean,
): Promise<string | null> {
  const deletionError = cleanupDebugApiSessionFixture(fixture);
  if (deletionError || !refreshPastChats) return deletionError;
  try {
    await postUi(connection, "app", { refreshPastChats: true });
    await waitForSelectorAbsent(
      connection,
      "app",
      `[data-debug-id="left-past-chat-row"][data-session-id="${fixture.id}"]`,
      "owned Past chats session cleanup",
    );
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

async function prepareOwnedVaultSecret(
  connection: Connection,
  secret: { key: string; value: string },
): Promise<VaultDirectory> {
  const baseline = await apiJson<VaultDirectory>(connection, "GET", "/vault/keys");
  if (vaultDirectoryHasKey(baseline, secret.key)) {
    throw new Error(`owned Vault key ${secret.key} already existed before setup`);
  }
  try {
    await apiJson(connection, "POST", "/vault/set", secret);
    const changed = await apiJson<VaultDirectory>(connection, "GET", "/vault/keys");
    if (!vaultDirectoryHasKey(changed, secret.key)) throw new Error("owned Vault secret metadata was not created");
    return baseline;
  } catch (error) {
    try {
      const current = await apiJson<VaultDirectory>(connection, "GET", "/vault/keys");
      if (vaultDirectoryHasKey(current, secret.key)) {
        await apiJson(connection, "POST", "/vault/delete", { key: secret.key });
      }
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; owned Vault setup cleanup: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

async function cleanupOwnedVaultSecret(
  connection: Connection,
  key: string,
  baseline: VaultDirectory,
): Promise<void> {
  const current = await apiJson<VaultDirectory>(connection, "GET", "/vault/keys");
  if (vaultDirectoryHasKey(current, key)) await apiJson(connection, "POST", "/vault/delete", { key });
  const restored = await apiJson<VaultDirectory>(connection, "GET", "/vault/keys");
  if (JSON.stringify(restored) !== JSON.stringify(baseline)) {
    throw new Error("owned Vault UI fixture did not restore the redacted key directory exactly");
  }
}

function vaultDirectoryHasKey(directory: VaultDirectory, key: string): boolean {
  return Array.isArray(directory.keys)
    && directory.keys.includes(key)
    && Array.isArray(directory.entries)
    && directory.entries.some((entry) => entry?.key === key);
}

const OWNED_VAULT_PASSPHRASE = "ShellX-Release-UI-Vault-Passphrase-035";

async function prepareOwnedVaultLifecycle(
  connection: Connection,
  lifecycle: OwnedVaultLifecycle,
): Promise<void> {
  const baseline = await apiJson<VaultStatus>(connection, "GET", "/vault/status");
  verifyVaultLifecycleStatus(baseline, "unconfigured");
  if (lifecycle === "setup-recovery-kit") return;
  try {
    const begun = await apiJson<Record<string, unknown>>(connection, "POST", "/vault/setup/begin", {
      target: "local",
      passphrase: OWNED_VAULT_PASSPHRASE,
      rememberDevice: false,
    });
    const kit = begun.recoveryKit;
    if (!kit || typeof kit !== "object" || Array.isArray(kit)) throw new Error("Vault setup omitted its recovery challenge");
    const confirmationId = (kit as Record<string, unknown>).confirmationId;
    const words = (kit as Record<string, unknown>).words;
    if (typeof confirmationId !== "string" || !/^[0-9a-f]{32}$/.test(confirmationId)
      || !Array.isArray(words) || words.length !== 16) {
      throw new Error("Vault setup returned an invalid recovery challenge");
    }
    await apiJson(connection, "POST", "/vault/setup/confirm-recovery", {
      confirmationId,
      importLegacy: false,
    });
    if (lifecycle === "configured-remembered") {
      await apiJson(connection, "POST", "/vault/remember-device", {
        enabled: true,
        passphrase: OWNED_VAULT_PASSPHRASE,
      });
    } else if (lifecycle === "configured-locked") {
      await apiJson(connection, "POST", "/vault/lock", {});
    }
    verifyVaultLifecycleStatus(await apiJson<VaultStatus>(connection, "GET", "/vault/status"), lifecycle);
  } catch (error) {
    try {
      await cleanupOwnedVaultLifecycle(connection);
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; owned Vault lifecycle cleanup: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

async function cleanupOwnedVaultLifecycle(connection: Connection): Promise<void> {
  await apiJson(connection, "POST", "/vault/e2e/reset", {});
  verifyVaultLifecycleStatus(
    await apiJson<VaultStatus>(connection, "GET", "/vault/status"),
    "unconfigured",
  );
}

function verifyVaultLifecycleStatus(
  status: VaultStatus,
  expected: Exclude<OwnedVaultLifecycle, "setup-recovery-kit"> | "unconfigured",
): void {
  const expectedStatus = expected === "unconfigured"
    ? { mode: "unconfigured", unlocked: false, recoveryConfirmed: false, rememberedDeviceEnabled: true }
    : {
        mode: "local",
        unlocked: expected !== "configured-locked",
        recoveryConfirmed: true,
        rememberedDeviceEnabled: expected === "configured-remembered",
      };
  for (const [key, value] of Object.entries(expectedStatus)) {
    if (status[key as keyof VaultStatus] !== value) {
      throw new Error(`Vault lifecycle status did not reach ${expected}: ${key}`);
    }
  }
}

async function cleanupOwnedBrowserFixture(
  connection: Connection,
  taskId: string,
  setup: BrowserFixtureSetup,
  ownedMissingRecipe: OwnedBrowserMissingRecipe | null,
): Promise<void> {
  const errors: string[] = [];
  try {
    await runPatchSteps(connection, "browser", setup.cleanupSteps);
    if (setup.cleanupAbsentSelector) {
      await waitForSelectorAbsent(
        connection,
        "browser",
        setup.cleanupAbsentSelector,
        "browser fixture cleanup",
      );
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    await postUi(connection, "browser", { rightTab: "chat", debugHighlights: [] });
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    await removeOwnedBookmarks(connection, setup.ownedBookmarks);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  if (ownedMissingRecipe) {
    try {
      if (existsSync(ownedMissingRecipe.rootPath)) rmSync(ownedMissingRecipe.rootPath, { recursive: true });
      if (existsSync(ownedMissingRecipe.rootPath)) throw new Error("owned missing-recipe root remained after deletion");
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  try {
    await abortOwnedBrowserTask(connection, taskId);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  await delay(100);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

async function runPatchSteps(
  connection: Connection,
  surface: ReleaseUiDebugSurface,
  steps: readonly ReleaseUiDebugPatchStep[] | undefined,
): Promise<void> {
  for (const step of steps ?? []) {
    await postUi(connection, surface, step.patch);
    await delay(step.delayMs ?? 200);
  }
}

const SETTINGS_TABS = [
  "general",
  "vault",
  "connections",
  "connectors",
  "desktop",
  "shellxagent",
  "data",
  "about",
] as const;

async function detectActiveSettingsTab(connection: Connection): Promise<string> {
  const idPrefix = "final-surface-settings-baseline";
  await postUi(connection, "app", {
    debugHighlights: SETTINGS_TABS.map((tab) => ({
      id: `${idPrefix}-${tab}`,
      selector: `[data-debug-id='settings-tab-${tab}'][aria-selected='true']`,
      label: `Settings ${tab}`,
      color: "cyan",
    })),
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const results = await readHighlightResults(connection, "app");
    const active = SETTINGS_TABS.find((tab) => (
      results.find((result) => result.id === `${idPrefix}-${tab}`)?.status === "resolved"
    ));
    if (active) {
      await postUi(connection, "app", { debugHighlights: [] });
      return active;
    }
    await delay(100);
  }
  await postUi(connection, "app", { debugHighlights: [] });
  throw new Error("active Settings tab could not be detected for exact restoration");
}

async function prepareOwnedBookmarks(
  connection: Connection,
  bookmarks: readonly ReleaseUiDebugOwnedBookmark[] | undefined,
  request: ReleaseSurfaceDriverRequest,
): Promise<OwnedBrowserMissingRecipe | null> {
  if (!bookmarks?.length) return null;
  await removeOwnedBookmarks(connection, bookmarks, false);
  const needsMissingRecipe = bookmarks.some((bookmark) => (
    bookmark.agentWorkflow?.recipePath === "__SHELLX_RELEASE_OWNED_MISSING_RECIPE__"
  ));
  const commitSegment = request.sourceCommit.slice(0, 12).replace(/[^a-f0-9]/gi, "0");
  const ownedMissingRecipe = needsMissingRecipe
    ? { rootPath: mkdtempSync(join(tmpdir(), `shellx-release-ui-browser-workflow-${commitSegment}-`)) }
    : null;
  try {
    for (const bookmark of bookmarks) {
      const agentWorkflow = bookmark.agentWorkflow?.recipePath === "__SHELLX_RELEASE_OWNED_MISSING_RECIPE__"
        ? {
            ...bookmark.agentWorkflow,
            recipePath: join(ownedMissingRecipe!.rootPath, "intentionally-missing-recipe.json"),
          }
        : bookmark.agentWorkflow;
      await apiJson(connection, "POST", "/browser/bookmarks", {
        ...bookmark,
        ...(agentWorkflow ? { agentWorkflow } : {}),
        category: "reference",
      });
    }
  } catch (error) {
    if (ownedMissingRecipe && existsSync(ownedMissingRecipe.rootPath)) {
      rmSync(ownedMissingRecipe.rootPath, { recursive: true });
    }
    throw error;
  }
  await delay(300);
  return ownedMissingRecipe;
}

async function removeOwnedBookmarks(
  connection: Connection,
  bookmarks: readonly ReleaseUiDebugOwnedBookmark[] | undefined,
  verify = true,
): Promise<void> {
  if (!bookmarks?.length) return;
  const before = await apiJson<{ bookmarks?: Array<{ bookmarkId?: string }> }>(
    connection,
    "GET",
    "/browser/bookmarks",
  );
  const present = new Set((before.bookmarks ?? []).map((bookmark) => bookmark.bookmarkId));
  for (const bookmark of [...bookmarks].reverse()) {
    if (!present.has(bookmark.bookmarkId)) continue;
    await apiJson(
      connection,
      "DELETE",
      `/browser/bookmarks/${encodeURIComponent(bookmark.bookmarkId)}`,
    );
  }
  if (!verify) return;
  const state = await apiJson<{ bookmarks?: Array<{ bookmarkId?: string }> }>(
    connection,
    "GET",
    "/browser/bookmarks",
  );
  const remaining = new Set((state.bookmarks ?? []).map((bookmark) => bookmark.bookmarkId));
  const leaked = bookmarks.find((bookmark) => remaining.has(bookmark.bookmarkId));
  if (leaked) throw new Error(`owned bookmark ${leaked.bookmarkId} remained after cleanup`);
}

async function abortOwnedBrowserTask(connection: Connection, taskId: string): Promise<void> {
  await apiJson(connection, "POST", "/browser/task/control", {
    taskId,
    action: "abort",
    reason: "finalSurfaceUiDebugCleanup",
  });
}

async function waitForSelectorResolved(
  connection: Connection,
  surface: ReleaseUiDebugSurface,
  selector: string,
  label: string,
): Promise<void> {
  const id = `final-surface-state-${safeId(label)}`;
  await postUi(connection, surface, {
    debugHighlights: [{ id, selector, label, color: "cyan" }],
  });
  try {
    await waitForHighlight(connection, surface, id, selector, label);
  } finally {
    await postUi(connection, surface, { debugHighlights: [] });
  }
}

async function waitForSelectorAbsent(
  connection: Connection,
  surface: ReleaseUiDebugSurface,
  selector: string,
  label: string,
): Promise<void> {
  const id = `final-surface-absent-${safeId(label)}`;
  await postUi(connection, surface, {
    debugHighlights: [{ id, selector, label, color: "cyan" }],
  });
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = (await readHighlightResults(connection, surface)).find((entry) => entry.id === id);
      if (result?.status === "missing") return;
      if (result?.status && result.status !== "pending" && result.status !== "resolved") {
        throw new Error(result.message || `cleanup highlight reported ${result.status}`);
      }
      await delay(100);
    }
    throw new Error(`${selector} remained visible after ${label}`);
  } finally {
    await postUi(connection, surface, { debugHighlights: [] });
  }
}

async function readHighlightResults(
  connection: Connection,
  surface: ReleaseUiDebugSurface,
): Promise<HighlightResult[]> {
  const state = await apiJson<{
    debugHighlightResults?: HighlightResult[];
    debugHighlightResultsBySurface?: Record<string, HighlightResult[]>;
  }>(connection, "GET", "/state/ui");
  return state.debugHighlightResultsBySurface?.[surface] ?? state.debugHighlightResults ?? [];
}

async function waitForHighlightCleared(
  connection: Connection,
  surface: ReleaseUiDebugSurface,
  id: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const results = await readHighlightResults(connection, surface);
    if (!results.some((result) => result.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`highlight ${id} remained after cleanup`);
}

async function waitForHighlight(
  connection: Connection,
  surface: ReleaseUiDebugSurface,
  id: string,
  selector: string,
  label: string,
): Promise<HighlightResult> {
  const deadline = Date.now() + 20_000;
  let last: HighlightResult | undefined;
  let lastBroadcastAt = 0;
  while (Date.now() < deadline) {
    const results = await readHighlightResults(connection, surface);
    last = results.find((result) => result.id === id);
    if (last?.status === "resolved") return last;
    if (last?.status && last.status !== "pending" && last.status !== "missing") {
      throw new Error(last.message || `highlight reported ${last.status}`);
    }
    if (Date.now() - lastBroadcastAt >= 1_000) {
      await postUi(connection, surface, {
        debugHighlights: [{ id, selector, label, color: "cyan" }],
      });
      lastBroadcastAt = Date.now();
    }
    await delay(150);
  }
  throw new Error(last?.message || `highlight ${id} did not resolve before timeout`);
}

async function postUi(
  connection: Connection,
  surface: ReleaseUiDebugSurface,
  body: Json,
): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: surface,
    source: "final-surface-ui-debug-driver",
    ...body,
  });
}

async function apiResponse(
  connection: { base: string; token: string },
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  return response;
}

async function apiJson<T>(
  connection: { base: string; token: string },
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return await (await apiResponse(connection, method, path, body)).json() as T;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
