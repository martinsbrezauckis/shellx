import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  type ReleaseSurfaceDriverManifest,
} from "../lib/release-surface-driver-protocol";
import {
  BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP,
  BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE,
  BROWSER_DEVELOPER_EVIDENCE_CONTROL_ORACLES,
  executeBrowserDeveloperEvidenceControls,
} from "./ui-browser-developer-evidence-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-browser-developer-evidence-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "scripts/release-drivers/ui-control-owned-browser-bookmarks.ts",
    "scripts/release-drivers/ui-browser-developer-evidence-lifecycle.ts",
    "scripts/release-drivers/ui-control-browser-developer-evidence-installed.ts",
  ],
  supportedFixtures: [BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE],
  supportedCleanups: [BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP],
  supportedOracles: [...BROWSER_DEVELOPER_EVIDENCE_CONTROL_ORACLES],
};

runReleaseSurfaceDriverCli(manifest, executeBrowserDeveloperEvidenceControls).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
