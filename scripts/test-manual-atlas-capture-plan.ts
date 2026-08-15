import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MANUAL_ATLAS_CAPTURE_PLAN } from "./lib/manual-atlas-capture-plan";

const root = resolve(import.meta.dirname, "..");
const captureSource = readFileSync(resolve(root, "scripts/capture-shellx-manual-atlas.ts"), "utf8");
const visuals = JSON.parse(readFileSync(resolve(root, "docs/public/manual/shellx/visuals.json"), "utf8")) as {
  captures: Record<string, unknown>;
};
const planIds = MANUAL_ATLAS_CAPTURE_PLAN.map((entry) => entry.id);
assert.equal(new Set(planIds).size, planIds.length, "manual atlas capture IDs must be unique");
assert.deepEqual(
  [...planIds].sort(),
  Object.keys(visuals.captures).sort(),
  "the installed-candidate capture plan must cover every exact atlas image once",
);
assert.equal(MANUAL_ATLAS_CAPTURE_PLAN.filter((entry) => entry.surface === "app").length, 27);
assert.equal(MANUAL_ATLAS_CAPTURE_PLAN.filter((entry) => entry.surface === "browser").length, 14);
assert(MANUAL_ATLAS_CAPTURE_PLAN.every((entry) => entry.intendedState.trim().length >= 24));
assert(MANUAL_ATLAS_CAPTURE_PLAN.every((entry) => entry.steps.some((step) => step.kind === "wait")));
for (const panel of ["chat", "requests", "actions", "evidence", "errors"]) {
  const entry = MANUAL_ATLAS_CAPTURE_PLAN.find((candidate) => candidate.id === `browser-panel-${panel}`);
  assert(entry, `Browser ${panel} atlas state must exist`);
  assert(
    entry.steps.some((step) => step.kind === "click"
      && step.selector === `[data-debug-id='shellx-browser-right-tab-${panel}']`),
    `Browser ${panel} atlas state must use a real renderer click instead of a deduplicated persistent patch`,
  );
}
for (const id of ["task-manager-schedule", "task-manager-providers"]) {
  const entry = MANUAL_ATLAS_CAPTURE_PLAN.find((candidate) => candidate.id === id);
  assert(entry, `${id} atlas state must exist`);
  assert(
    entry.steps.some((step) => step.kind === "click"
      && step.selector === "[data-debug-id='task-manager-edit-details']"),
    `${id} must deliberately leave the saved-task review before capturing editable controls`,
  );
}
assert(captureSource.includes('requiredArg(args, "--app-demo-cwd")'));
assert(captureSource.includes('optionalArg(args, "--app-demo-cwd-launch")'));
assert(captureSource.includes('endsWith("/shellx-manual-demo")'));
assert(captureSource.includes("tabId: await resolveActiveAppTabId()"));
assert(captureSource.includes("cwd: appDemoCwdLaunch"));
assert(captureSource.includes("window.devicePixelRatio || 1"));
assert(captureSource.includes("Math.round(width / devicePixelRatio)"));
assert(captureSource.includes("Math.round(height / devicePixelRatio)"));

console.log("Manual atlas installed-candidate capture plan passed: 41 exact UI states");
