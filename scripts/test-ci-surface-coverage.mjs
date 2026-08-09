import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ciSurfaceCoverageErrors } from "./lib/ci-surface-coverage.mjs";
import { TEST_SUITES } from "./test-suite-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const ciSource = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const releaseSource = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const buildScript = readFileSync(resolve(root, "src-tauri/build.rs"), "utf8");
const packageData = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const inventory = JSON.parse(readFileSync(resolve(root, "release/surface-inventory.json"), "utf8"));
const driverPlan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8"));

const input = {
  ciSource,
  buildScript,
  packageEngines: packageData.engines,
  packageScripts: packageData.scripts,
  releaseSource,
  inventory,
  driverPlan,
  testSuites: TEST_SUITES,
};
assert.deepEqual(ciSurfaceCoverageErrors(input), []);

const missingWindows = ciSurfaceCoverageErrors({
  ...input,
  ciSource: ciSource.replace("          - windows-latest\n", ""),
});
assert(missingWindows.some((error) => error.includes("missing windows-latest")));

const incompleteCommand = ciSurfaceCoverageErrors({
  ...input,
  packageScripts: { ...packageData.scripts, "ci:surface-contracts": "pnpm test" },
});
assert(incompleteCommand.some((error) => error.includes("inventory, driver plan")));

const staleNodeBaseline = ciSurfaceCoverageErrors({
  ...input,
  ciSource: ciSource.replaceAll("node-version: 22", "node-version: 20"),
});
assert(staleNodeBaseline.some((error) => error.includes("Node 22 minimum")));

const staleBuildNodeBaseline = ciSurfaceCoverageErrors({
  ...input,
  releaseSource: releaseSource.replace("node-version: 22", "node-version: 20"),
});
assert(staleBuildNodeBaseline.some((error) => error.includes("Node 22 minimum")));

const duplicateWindowsManifest = ciSurfaceCoverageErrors({
  ...input,
  buildScript: buildScript.replace("WindowsAttributes::new_without_app_manifest()", "WindowsAttributes::new()"),
});
assert(duplicateWindowsManifest.some((error) => error.includes("duplicate app manifest")));

const missingAssignment = structuredClone(driverPlan);
missingAssignment.assignments = missingAssignment.assignments.slice(1);
assert(ciSurfaceCoverageErrors({ ...input, driverPlan: missingAssignment })
  .some((error) => error.includes("has no driver assignment")));

const buildingPlan = structuredClone(driverPlan);
buildingPlan.assignments[0].expectedEffect = "BUILDING: deliberate red-proof";
assert(ciSurfaceCoverageErrors({ ...input, driverPlan: buildingPlan })
  .some((error) => error.includes("remains BUILDING")));

const productionOnlyAudit = ciSurfaceCoverageErrors({
  ...input,
  packageScripts: { ...packageData.scripts, "audit:dependencies": "pnpm audit --prod" },
});
assert(productionOnlyAudit.some((error) => error.includes("complete lockfile")));

console.log(
  `CI surface coverage passed: ${inventory.items.length} assignments, `
  + `${TEST_SUITES.pretest.length + TEST_SUITES.test.length} registered checks, 3 host OSes, full lockfile audit`,
);
