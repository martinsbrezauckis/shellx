import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ReleaseSurfaceDriverManifest,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  UI_CONTROL_INSTALLED_MANIFEST,
  executeUiControlInstalled,
} from "./ui-control-installed";
import {
  UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID,
  assertBoundedInstalledUiControlAssignments,
} from "./ui-control-bounded-installed-assignments";

const manifest: ReleaseSurfaceDriverManifest = {
  ...UI_CONTROL_INSTALLED_MANIFEST,
  id: UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID,
  controllerFiles: [
    "scripts/release-drivers/ui-control-installed.ts",
    "scripts/release-drivers/ui-control-bounded-installed-assignments.ts",
    ...(UI_CONTROL_INSTALLED_MANIFEST.controllerFiles ?? []),
  ],
};

async function executeBoundedUiControl(request: ReleaseSurfaceDriverRequest) {
  assertBoundedInstalledUiControlAssignments(request.assignments);
  return executeUiControlInstalled(request);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runReleaseSurfaceDriverCli(manifest, executeBoundedUiControl).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
