import assert from "node:assert/strict";
import { resolve } from "node:path";
import { collectReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  RELEASE_UI_DRIVER_FAMILY_CONTRACTS,
  RELEASE_UI_DRIVER_FAMILY_CONTRACT_SCHEMA,
  releaseUiDriverFamilyContract,
  validateReleaseUiControlOracle,
  validateReleaseUiSurfaceMetadata,
} from "./lib/release-ui-driver-families";

const inventory = collectReleaseSurfaceInventory(resolve(import.meta.dirname, ".."));
const uiSurfaces = inventory.items.filter((item) => (
  item.kind === "ui-control" || item.kind === "ui-debug-surface"
));

assert.deepEqual(inventory.uiDriverFamilyAccounting, {
  selection: 49,
  disclosure: 25,
  toggle: 59,
  "text-entry": 83,
  choice: 21,
  range: 2,
  "file-picker": 0,
  activation: 406,
  "static-marker": 488,
  "dynamic-marker": 34,
}, "every exact UI occurrence must belong to one deterministic installed-driver family");

for (const surfaceId of [
  'ui-control:src/components/BuildRunCockpit.tsx::is([title="Show every receipt in this Build Mode run"],[title="Show latest receipts only"])@src/components/BuildRunCockpit.tsx#8',
  'ui-control:src/components/MediaPreview.tsx:[data-debug-id="surface-components-mediapreview-1"]@src/components/MediaPreview.tsx#1',
  'ui-control:src/components/PRCreateModal.tsx::is([title="Append the session transcript as an appendix"],[title="No transcript captured yet"])@src/components/PRCreateModal.tsx#7',
  'ui-control:src/components/TasksPanel.tsx:[aria-label="Clean Host MCP children for this tab"]@src/components/TasksPanel.tsx#4',
]) {
  assert.equal(
    inventory.items.find((item) => item.id === surfaceId)?.driverFamily,
    "toggle",
    `${surfaceId} must retain boolean-state proof rather than generic activation proof`,
  );
}

assert.deepEqual(
  uiSurfaces.flatMap(validateReleaseUiSurfaceMetadata),
  [],
  "UI inventory metadata must satisfy the reusable driver-family contracts",
);
assert(
  uiSurfaces.every((surface) => releaseUiDriverFamilyContract(surface).schema === RELEASE_UI_DRIVER_FAMILY_CONTRACT_SCHEMA),
  "every UI surface must resolve to one versioned family contract",
);
assert(
  inventory.items.filter((item) => item.kind === "ui-control")
    .every((item) => item.eventTrust === "native-required" && Boolean(item.elementTag)),
  "final user-control coverage must require native events and retain intrinsic element identity",
);
assert(
  inventory.items.filter((item) => item.kind === "ui-debug-surface")
    .every((item) => item.eventTrust === "not-applicable"),
  "debug addressability markers must not be mislabeled as user actions",
);

const selection = inventory.items.find((item) => item.kind === "ui-control" && item.driverFamily === "selection");
assert(selection, "selection fixture is present");
assert.deepEqual(validateReleaseUiControlOracle(selection, "ui:selection-state-transition"), []);
assert(validateReleaseUiControlOracle(selection, "ui:visible-nonempty-rectangle").length > 0);

const activation = inventory.items.find((item) => item.kind === "ui-control" && item.driverFamily === "activation");
assert(activation, "activation fixture is present");
assert.deepEqual(validateReleaseUiControlOracle(activation, "ui:activation:exact-owner-state"), []);
assert(validateReleaseUiControlOracle(activation, "ui:activation:visible-rectangle").length > 0);
assert(validateReleaseUiControlOracle(activation, "ui:activation:").length > 0);

const fileContract = RELEASE_UI_DRIVER_FAMILY_CONTRACTS["file-picker"];
assert.equal(fileContract.invocation, "native-file-chooser");
assert.equal(fileContract.effectProof, "attachment-identity");
assert.equal(fileContract.cleanupProof, "remove-owned-attachment");

const activationContract = RELEASE_UI_DRIVER_FAMILY_CONTRACTS.activation;
assert.equal(activationContract.effectProof, "typed-semantic-effect");
assert.equal(activationContract.requiresSpecializedOracle, true);

console.log(
  `Release UI driver-family contracts passed: ${uiSurfaces.length} exact UI occurrences across `
  + `${Object.keys(RELEASE_UI_DRIVER_FAMILY_CONTRACTS).length} reusable families`,
);
