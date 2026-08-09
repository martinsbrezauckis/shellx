import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  loadFinalSurfaceDriverPlan,
  verifyFinalSurfaceDriverPlan,
} from "./lib/release-surface-driver-plan";
import { validateFinalSurfaceLedgerMarker } from "./lib/release-surface-driver-plan-doc";

const root = resolve(import.meta.dirname, "..");
const inventory = JSON.parse(readFileSync(resolve(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const plan = loadFinalSurfaceDriverPlan(resolve(root, "release", "surface-driver-plan.json"));
const result = verifyFinalSurfaceDriverPlan(plan, inventory, root);
const gateDoc = readFileSync(resolve(root, "release", "FINAL_SURFACE_GATE.md"), "utf8");
const docFindings = validateFinalSurfaceLedgerMarker(gateDoc, result);

console.log(`ShellX final surface driver plan: ${result.status.toUpperCase()}`);
console.log(
  `Ready ${result.counts.ready}/${result.counts.inventoryCells} platform cells across ${result.counts.inventoryItems} surfaces;`
  + ` assigned ${result.counts.assigned}; missing ${result.counts.missing}`,
);
for (const finding of result.findings) {
  console.log(`FAIL ${finding.ruleId}${finding.surfaceId ? ` [${finding.surfaceId}]` : ""}: ${finding.detail}`);
}
for (const finding of docFindings) {
  console.log(`FAIL driver-plan-doc-status: ${finding}`);
}
process.exit(result.status === "invalid" || docFindings.length > 0 ? 1 : 0);
