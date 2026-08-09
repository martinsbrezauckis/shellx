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
  BROWSER_PERSONAL_LOCK_CLEANUPS,
  BROWSER_PERSONAL_LOCK_FIXTURES,
  BROWSER_PERSONAL_LOCK_ORACLES,
  exerciseBrowserPersonalLockControl,
  supportsBrowserPersonalLockControl,
} from "./ui-control-browser-personal-lock-settings";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-debug-browser-personal-lock-lifecycle-installed",
  kind: "ui-debug-surface",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "scripts/release-drivers/ui-control-browser-personal-lock-settings.ts",
    "src/browser/components/BrowserMenus.tsx",
    "src/components/ShellxBrowserApp.tsx",
    "src-tauri/src/debug_api_session_state.rs",
    "src-tauri/src/shellx_browser_persistence.rs",
  ],
  supportedFixtures: [...BROWSER_PERSONAL_LOCK_FIXTURES],
  supportedCleanups: [...BROWSER_PERSONAL_LOCK_CLEANUPS],
  supportedOracles: [...BROWSER_PERSONAL_LOCK_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  if (request.assignments.length < 1 || !request.assignments.every(supportsBrowserPersonalLockControl)) {
    throw new Error("Browser Personal Lock debug driver received an unsupported marker assignment");
  }
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseBrowserPersonalLockControl(connection, installedInput, assignment));
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
