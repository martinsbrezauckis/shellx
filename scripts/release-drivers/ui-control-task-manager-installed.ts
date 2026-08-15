import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReleaseSurfaceInstalledInputSession } from "../lib/release-surface-installed-input-client";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { exerciseTaskManagerControls } from "./ui-control-task-manager";
import {
  TASK_MANAGER_CONTROL_CLEANUP,
  TASK_MANAGER_CONTROL_DRIVER_ID,
  TASK_MANAGER_CONTROL_FIXTURE,
  TASK_MANAGER_CONTROL_ORACLES,
} from "./ui-task-manager-installed-assignments";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: TASK_MANAGER_CONTROL_DRIVER_ID,
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/release-drivers/ui-task-manager-installed-assignments.ts",
    "scripts/release-drivers/ui-control-task-manager.ts",
  ],
  supportedFixtures: [TASK_MANAGER_CONTROL_FIXTURE],
  supportedCleanups: [TASK_MANAGER_CONTROL_CLEANUP],
  supportedOracles: [...TASK_MANAGER_CONTROL_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = await exerciseTaskManagerControls(connection, input, request.assignments);
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
