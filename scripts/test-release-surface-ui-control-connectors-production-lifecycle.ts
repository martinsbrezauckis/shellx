import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";

const root = resolve(import.meta.dirname, "..");
const driverId = "ui-control-connectors-production-lifecycle-installed";
const exactNames = new Set([
  'src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-1"]',
  'src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-12"]',
  'src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-17"]',
  'src/components/settings/ConnectorsTab.tsx:[data-debug-id="surface-components-settings-connectorstab-18"]',
  'src/components/settings/ConnectorsTab.tsx:role=button;name="Delete"',
]);

const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
const assignments = plan.assignments.filter((assignment) => assignment.driverId === driverId);
assert.equal(assignments.length, 5);
assert.deepEqual(new Set(assignments.map((assignment) => inventoryById.get(assignment.surfaceId)?.name)), exactNames);
assert(assignments.every((assignment) => assignment.fixtureId.startsWith("ui:connectors-production-owned-")));
assert(assignments.every((assignment) => assignment.oracleId === "ui:activation:owned-connector-production-transition"));
assert(assignments.every((assignment) => (
  assignment.cleanupId === "ui:delete-owned-connectors-reset-isolated-vault-restore-settings-and-teardown-profile"
)));
assert(assignments.every((assignment) => !assignment.expectedEffect.includes("SHELLX_RELEASE_CONNECTOR_TOKEN_INVALID_SHAPE_035")));
assert.equal(plan.assignments.filter((assignment) => (
  exactNames.has(inventoryById.get(assignment.surfaceId)?.name ?? "")
    && assignment.driverId.endsWith("-backlog-installed")
)).length, 0);

const described = spawnSync(process.execPath, [
  "--import", "tsx", join(root, "scripts/release-drivers/ui-control-connectors-production-lifecycle-installed.ts"), "--describe",
], { cwd: root, encoding: "utf8" });
assert.equal(described.status, 0, described.stderr || described.stdout);
const manifest = JSON.parse(described.stdout) as {
  id: string;
  kind: string;
  runtimeBinding: string;
  invocationTransport: string;
  supportedFixtures: string[];
  supportedCleanups: string[];
  supportedOracles: string[];
  controllerFiles: string[];
};
assert.equal(manifest.id, driverId);
assert.equal(manifest.kind, "ui-control");
assert.equal(manifest.runtimeBinding, "attested-process");
assert.equal(manifest.invocationTransport, "native-installed-input");
assert.equal(manifest.supportedFixtures.length, 5);
assert.deepEqual(manifest.supportedCleanups, [
  "ui:delete-owned-connectors-reset-isolated-vault-restore-settings-and-teardown-profile",
]);
assert.deepEqual(manifest.supportedOracles, ["ui:activation:owned-connector-production-transition"]);
assert(manifest.controllerFiles.includes("src-tauri/src/outside_connectors.rs"));

const driver = readFileSync(join(root, "scripts/release-drivers/ui-control-connectors-production-lifecycle-installed.ts"), "utf8");
for (const command of [
  "outside_connectors_save",
  "outside_connectors_list",
  "outside_connectors_events",
  "outside_connectors_delete",
]) assert(driver.includes(`\"${command}\"`), `driver must use production ${command}`);
for (const selector of [
  "surface-components-settings-connectorstab-1",
  "surface-components-settings-connectorstab-12",
  "surface-components-settings-connectorstab-17",
  "surface-components-settings-connectorstab-18",
  "settings-pill-danger",
]) assert(driver.includes(selector), `driver must natively address ${selector}`);
assert(driver.includes("releaseSurfaceProfileLaunchRootFromDebugTokenPath"));
assert(driver.includes('connectionTransport !== "local"'));
assert(driver.includes('enabled: false'));
assert(driver.includes('dispatchMode: "inbox"'));
assert(driver.includes('event.status !== "rejected"'));
assert(driver.includes('event.reason !== "connector is disabled"'));
assert(driver.includes("telegram bot token must have '<digits>:<token>' shape"));
assert(driver.includes('await resetVault(connection, "cleanup reset")'));
assert(driver.includes('await relay.invoke("outside_connectors_delete"'));
assert(driver.includes("await relay.cleanup()"));
assert(driver.includes('openModal: "close"'));
assert(driver.includes("waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS_DIALOG)"));
assert(!driver.includes("api.telegram.org"));
assert(!driver.includes("discord.com"));
assert(!driver.includes("fetch(\"http"));

const connectorSource = readFileSync(join(root, "src-tauri/src/outside_connectors.rs"), "utf8");
const normalizeStart = connectorSource.indexOf("pub(crate) fn normalize_telegram_bot_token");
const testStart = connectorSource.indexOf("async fn test_telegram");
const tokenNormalize = connectorSource.indexOf("normalize_telegram_bot_token(&token)", testStart);
const clientCreate = connectorSource.indexOf("reqwest::Client::builder()", testStart);
assert(normalizeStart >= 0 && testStart >= 0 && tokenNormalize > testStart && clientCreate > tokenNormalize,
  "the deliberate invalid token must fail before the production HTTP client is created");
assert(connectorSource.includes("self.record_event(event.clone()).await?"));
assert(connectorSource.includes("persist(&self.path, &guard)?"));
assert(connectorSource.includes("guard.retain(|c| c.id != id)"));

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
assert.equal(
  packageJson.scripts?.["test:release-ui-control-connectors-production"],
  "tsx scripts/test-release-surface-ui-control-connectors-production-lifecycle.ts",
);

console.log("Connectors production lifecycle contracts passed: 5 exact native controls, isolated Vault/store cleanup, and pre-network Test proof");
