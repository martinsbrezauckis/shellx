import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  type ReleaseSurfaceDriverManifest,
} from "../lib/release-surface-driver-protocol";
import {
  executeNativePickerLifecycleDriver,
} from "./native-picker-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "palette-action-native-picker-installed",
  kind: "palette-action",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "scripts/release-drivers/native-picker-lifecycle.ts",
  ],
  supportedFixtures: ["native-picker:owned-file-empty-composer"],
  supportedCleanups: ["native-picker:remove-exact-attachment-restore-tab-delete-fixture"],
  supportedOracles: ["native-picker:exact-owned-file-attached"],
};

runReleaseSurfaceDriverCli(manifest, executeNativePickerLifecycleDriver).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
