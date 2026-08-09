import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { createReleaseSurfaceInstalledInputSession } from "../lib/release-surface-installed-input-client";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  TASKS_PANEL_LIFECYCLE_CLEANUPS,
  TASKS_PANEL_LIFECYCLE_FIXTURES,
  TASKS_PANEL_LIFECYCLE_ORACLES,
  exerciseTasksPanelLifecycle,
  supportsTasksPanelLifecycleControl,
} from "./ui-control-tasks-panel-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-tasks-panel-lifecycle-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/lib/release-surface-run-profile.ts",
    "scripts/lib/release-surface-tauri-invoke-client.ts",
    "scripts/release-drivers/ui-control-tasks-panel-lifecycle.ts",
  ],
  supportedFixtures: [...TASKS_PANEL_LIFECYCLE_FIXTURES],
  supportedCleanups: [...TASKS_PANEL_LIFECYCLE_CLEANUPS],
  supportedOracles: [...TASKS_PANEL_LIFECYCLE_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const relay = new ReleaseSurfaceTauriInvokeSession(connection);
  if (!request.assignments.every(supportsTasksPanelLifecycleControl)) {
    throw new Error("TasksPanel lifecycle driver received an unsupported control");
  }
  const outcomes = await exerciseTasksPanelLifecycle(
    connection,
    installedInput,
    relay,
    request.assignments,
    request,
  );
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
    nativeWebDriver: request.nativeWebDriver,
    macosNativeInput: request.macosNativeInput,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
