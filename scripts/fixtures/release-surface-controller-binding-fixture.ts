import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createReleaseSurfaceControllerBinding } from "../lib/release-surface-controller-binding";
import type { ReleaseSurfaceControllerBinding } from "../lib/release-surface-controller-binding";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "../release-drivers/ui-control-installed-manifest";

export const releaseSurfaceFixtureRoot = resolve(import.meta.dirname, "../..");
export const releaseSurfaceFixtureSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: releaseSurfaceFixtureRoot,
  encoding: "utf8",
}).trim();

export function releaseSurfaceControllerBindingFixture(
  entrypoint: string,
  auxiliaryFiles: string[] = [],
) {
  const exactAuxiliaryFiles = entrypoint === "scripts/release-drivers/ui-control-installed.ts"
    ? [...UI_CONTROL_INSTALLED_CONTROLLER_FILES]
    : auxiliaryFiles;
  return createReleaseSurfaceControllerBinding({
    rootDir: releaseSurfaceFixtureRoot,
    sourceCommit: releaseSurfaceFixtureSourceCommit,
    entrypoint,
    auxiliaryFiles: exactAuxiliaryFiles,
  });
}

export function releaseSurfaceUiControlControllerBindingFixture() {
  return releaseSurfaceControllerBindingFixture(
    "scripts/release-drivers/ui-control-installed.ts",
    [...UI_CONTROL_INSTALLED_CONTROLLER_FILES],
  );
}

export function releaseSurfaceBoundedUiControlControllerBindingFixture() {
  return releaseSurfaceControllerBindingFixture(
    "scripts/release-drivers/ui-control-bounded-installed.ts",
    [
      "scripts/release-drivers/ui-control-installed.ts",
      "scripts/release-drivers/ui-control-bounded-installed-assignments.ts",
      ...UI_CONTROL_INSTALLED_CONTROLLER_FILES,
    ],
  );
}

export function syntheticReleaseSurfaceControllerBinding(
  sourceCommit: string,
): ReleaseSurfaceControllerBinding {
  return {
    sourceCommit,
    sourceTreeOid: "1".repeat(40),
    node: { basename: "node", sha256: "2".repeat(64), bytes: 100 },
    tsxLoader: { basename: "loader.mjs", sha256: "3".repeat(64), bytes: 100 },
    entrypoint: {
      relativePath: "scripts/fixtures/release-surface-driver-fixture.ts",
      basename: "release-surface-driver-fixture.ts",
      sha256: "4".repeat(64),
      bytes: 100,
    },
    auxiliaryFiles: [],
  };
}
