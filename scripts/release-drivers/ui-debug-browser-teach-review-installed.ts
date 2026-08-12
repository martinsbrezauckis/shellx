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
  BROWSER_TEACH_INSTALLED_CLEANUP,
  BROWSER_TEACH_INSTALLED_DEBUG_ORACLE,
  BROWSER_TEACH_INSTALLED_FIXTURE,
  browserTeachDebugOutcomes,
  runBrowserTeachInstalledLifecycle,
} from "./ui-browser-teach-review-installed";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-debug-browser-teach-review-installed",
  kind: "ui-debug-surface",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-run-profile.ts",
    "scripts/lib/release-surface-tauri-invoke-client.ts",
    "scripts/release-drivers/browser-teach-developer-fixture.ts",
    "scripts/release-drivers/ui-browser-teach-review-installed.ts",
    "scripts/release-drivers/ui-debug-browser-teach-review-installed.ts",
  ],
  supportedFixtures: [BROWSER_TEACH_INSTALLED_FIXTURE],
  supportedCleanups: [BROWSER_TEACH_INSTALLED_CLEANUP],
  supportedOracles: [BROWSER_TEACH_INSTALLED_DEBUG_ORACLE],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const proof = await runBrowserTeachInstalledLifecycle(connection, input, request);
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
    outcomes: browserTeachDebugOutcomes(request.assignments, proof),
  };
}

runReleaseSurfaceDriverCli(manifest, execute);
