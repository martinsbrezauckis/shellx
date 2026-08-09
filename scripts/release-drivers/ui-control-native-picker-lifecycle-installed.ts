import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  type ReleaseSurfaceDriverManifest,
} from "../lib/release-surface-driver-protocol";
import {
  NATIVE_PICKER_CLEANUPS,
  NATIVE_PICKER_FIXTURES,
  NATIVE_PICKER_ORACLES,
  executeNativePickerLifecycleDriver,
} from "./native-picker-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-native-picker-lifecycle-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "scripts/release-drivers/native-picker-lifecycle.ts",
  ],
  supportedFixtures: [...NATIVE_PICKER_FIXTURES],
  supportedCleanups: [...NATIVE_PICKER_CLEANUPS],
  supportedOracles: [...NATIVE_PICKER_ORACLES],
};

runReleaseSurfaceDriverCli(manifest, executeNativePickerLifecycleDriver).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
