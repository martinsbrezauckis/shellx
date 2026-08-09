import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { createReleaseSurfaceInstalledInputSession } from "../lib/release-surface-installed-input-client";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { exerciseProviderActionLifecycle } from "./ui-control-provider-action-lifecycle-installed";

const DRIVER_ID = "palette-action-provider-action-installed";
const ACTION = "work-preview-palette-ask-fix";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: DRIVER_ID,
  kind: "palette-action",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/lib/release-surface-run-profile.ts",
    "scripts/lib/release-surface-tauri-invoke-client.ts",
    "scripts/release-drivers/palette-action-provider-action-installed.ts",
    "scripts/release-drivers/ui-control-provider-action-lifecycle-installed.ts",
    "scripts/release-drivers/ui-control-work-preview-start.ts",
    "scripts/release-drivers/debug-api-browser-settle-fixture.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "src/lib/debug-provider-action-fixture.ts",
  ],
  supportedFixtures: [`ui:provider-action-owned-${ACTION}`],
  supportedCleanups: ["ui:stop-owned-provider-action-delete-project-and-restore-view"],
  supportedOracles: ["ui:activation:provider-action-prompt-dispatched"],
};

export async function executePaletteProviderAction(
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseProviderActionLifecycle(connection, input, request, assignment, {
      action: ACTION,
      selector: "[data-palette-action-id='act-preview-doctor']",
      openPalette: true,
    }));
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReleaseSurfaceDriverCli(manifest, executePaletteProviderAction).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
