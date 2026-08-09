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
  RIGHT_RAIL_GIT_WRITE_CLEANUPS,
  RIGHT_RAIL_GIT_WRITE_FIXTURES,
  RIGHT_RAIL_GIT_WRITE_ORACLES,
  exerciseRightRailGitWriteLifecycle,
  supportsRightRailGitWriteControl,
} from "./ui-control-right-rail-git-write-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-right-rail-git-write-lifecycle-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/release-drivers/debug-api-session-fixture.ts",
    "scripts/release-drivers/ui-control-work-preview-start.ts",
    "scripts/release-drivers/ui-control-right-rail-git-write-lifecycle.ts",
  ],
  supportedFixtures: [...RIGHT_RAIL_GIT_WRITE_FIXTURES],
  supportedCleanups: [...RIGHT_RAIL_GIT_WRITE_CLEANUPS],
  supportedOracles: [...RIGHT_RAIL_GIT_WRITE_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  if (!request.assignments.every(supportsRightRailGitWriteControl)) {
    throw new Error("RightRail/GitPane write lifecycle driver received an unsupported control");
  }
  const outcomes = await exerciseRightRailGitWriteLifecycle(
    connection,
    installedInput,
    request,
    request.assignments,
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
