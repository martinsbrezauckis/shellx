import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectReleaseSurfaceInventory,
  inventoryJson,
} from "./lib/release-surface-inventory";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "release", "surface-inventory.json");
const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;
const inventory = collectReleaseSurfaceInventory(root);
const expected = inventoryJson(inventory);

if (write) {
  writeFileSync(output, expected, "utf8");
  console.log(`Wrote ${output}`);
}

if (check) {
  let actual = "";
  try {
    actual = readFileSync(output, "utf8");
  } catch {
    console.error(`Release surface inventory is missing: ${output}`);
    console.error("Run: pnpm run surface:inventory:write");
    process.exit(1);
  }
  if (actual !== expected) {
    console.error("Release surface inventory drifted from shipped source.");
    console.error("Run pnpm run surface:inventory:write, then classify and test every new or changed surface.");
    process.exit(1);
  }
}

const counts = Object.entries(inventory.counts).map(([kind, count]) => `${kind}=${count}`).join(", ");
console.log(`Release surface inventory OK ${inventory.digest}: ${counts}`);
console.log(`Interactive controls without a usable selector: ${inventory.unresolvedInteractiveControls}`);
console.log(`Interactive controls using copy-derived selectors: ${inventory.copyDerivedInteractiveControls}`);
console.log(
  `UI occurrence accounting: ${inventory.occurrenceAccounting.uiControls.candidates} candidates, `
  + `${inventory.occurrenceAccounting.uiControls.excludedNonActions} non-actions excluded, `
  + `${inventory.occurrenceAccounting.uiControls.finiteVariantInstances} finite menu instances, `
  + `${inventory.occurrenceAccounting.uiDebugSurfaces.inventoried} debug markers inventoried`,
);
