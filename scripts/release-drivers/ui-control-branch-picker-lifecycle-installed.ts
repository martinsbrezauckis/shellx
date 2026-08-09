import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { createReleaseSurfaceInstalledInputSession } from "../lib/release-surface-installed-input-client";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  BRANCH_PICKER_LIFECYCLE_CLEANUPS,
  BRANCH_PICKER_LIFECYCLE_DRIVER_ID,
  BRANCH_PICKER_LIFECYCLE_FIXTURES,
  BRANCH_PICKER_LIFECYCLE_ORACLES,
  exerciseBranchPickerLifecycleControl,
  supportsBranchPickerLifecycleControl,
} from "./ui-control-branch-picker-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: BRANCH_PICKER_LIFECYCLE_DRIVER_ID,
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/release-drivers/debug-api-git-fixture.ts",
    "scripts/release-drivers/ui-control-branch-picker-lifecycle.ts",
  ],
  supportedFixtures: [...BRANCH_PICKER_LIFECYCLE_FIXTURES],
  supportedCleanups: [...BRANCH_PICKER_LIFECYCLE_CLEANUPS],
  supportedOracles: [...BRANCH_PICKER_LIFECYCLE_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  if (request.assignments.length !== 1 || !supportsBranchPickerLifecycleControl(request.assignments[0]!)) {
    throw new Error("BranchPicker lifecycle driver requires its one exact owned selection assignment");
  }
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcome = await exerciseBranchPickerLifecycleControl(
    connection,
    input,
    request,
    request.assignments[0]!,
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
    outcomes: [outcome],
  };
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
