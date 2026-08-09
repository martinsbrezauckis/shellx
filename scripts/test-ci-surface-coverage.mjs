import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ciSurfaceCoverageErrors } from "./lib/ci-surface-coverage.mjs";
import { TEST_SUITES } from "./test-suite-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const ciSource = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const packageData = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const inventory = JSON.parse(readFileSync(resolve(root, "release/surface-inventory.json"), "utf8"));
const driverPlan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8"));

const input = {
  ciSource,
  packageScripts: packageData.scripts,
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
