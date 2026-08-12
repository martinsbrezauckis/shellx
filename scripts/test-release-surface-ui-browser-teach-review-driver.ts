import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BROWSER_TEACH_CONTROL_SURFACE_IDS,
  BROWSER_TEACH_DEBUG_SURFACE_IDS,
  BROWSER_TEACH_INSTALLED_CLEANUP,
  BROWSER_TEACH_INSTALLED_FIXTURE,
} from "./release-drivers/ui-browser-teach-review-installed";

type Plan = { assignments?: Array<{ surfaceId?: string }> };

const root = resolve(new URL("..", import.meta.url).pathname);
const plan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8")) as Plan;
const teachAssignments = (plan.assignments ?? []).filter((assignment) => assignment.surfaceId?.includes("BrowserTeachReview"));
const controlAssignments = teachAssignments.filter((assignment) => assignment.surfaceId?.startsWith("ui-control:"));
const debugAssignments = teachAssignments.filter((assignment) => assignment.surfaceId?.startsWith("ui-debug-surface:"));

assert.equal(teachAssignments.length, 39, "Browser Teach review stays scoped to exactly 39 installed-driver assignments");
assert.equal(controlAssignments.length, 12, "Browser Teach review has exactly 12 native controls");
assert.equal(debugAssignments.length, 27, "Browser Teach review has exactly 27 static/dynamic debug markers");
assert.deepEqual(new Set(controlAssignments.map((assignment) => assignment.surfaceId)), BROWSER_TEACH_CONTROL_SURFACE_IDS);
assert.deepEqual(
  new Set(debugAssignments.map((assignment) => assignment.surfaceId?.replace(/^ui-debug-surface:([^@]+)@.*$/, "$1"))),
  BROWSER_TEACH_DEBUG_SURFACE_IDS,
);

for (const entrypoint of [
  "scripts/release-drivers/ui-control-browser-teach-review-installed.ts",
  "scripts/release-drivers/ui-debug-browser-teach-review-installed.ts",
]) {
  const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as Record<string, unknown>;
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedFixtures, [BROWSER_TEACH_INSTALLED_FIXTURE]);
  assert.deepEqual(manifest.supportedCleanups, [BROWSER_TEACH_INSTALLED_CLEANUP]);
  assert.equal((manifest.controllerFiles as string[]).includes("scripts/release-drivers/ui-browser-teach-review-installed.ts"), true);
}

const lifecycle = readFileSync(resolve(root, "scripts/release-drivers/ui-browser-teach-review-installed.ts"), "utf8");
const fixture = readFileSync(resolve(root, "scripts/release-drivers/browser-teach-developer-fixture.ts"), "utf8");
assert(lifecycle.includes("createAgentRevisionConflict") && lifecycle.includes('"/browser/teach/revise"'), "driver creates only a controlled revision conflict through the agent route");
assert(!lifecycle.includes("/browser/teach/approve") && !lifecycle.includes("approve_teach_draft_from_operator"), "driver cannot approve through the Debug API");
assert(lifecycle.includes("nativeClick(input, APPROVE)") && lifecycle.includes("nativeClick(input, REHEARSE)"), "approval and rehearsal require native installed input");
assert(lifecycle.includes("verifyIsolatedVaultCandidate") && lifecycle.includes("releaseSurfaceProfileMarkerLaunchPath"), "Vault fixture is bound to the exact attested disposable candidate profile marker");
assert(lifecycle.includes("prepareIsolatedLockedVault") && lifecycle.includes("shellx_vault_unlock") && lifecycle.includes("shellx-browser-teach-vault-unavailable"), "driver proves the real isolated locked-Vault unavailable state before synthetic unlock");
assert(lifecycle.includes("seedOwnedVaultBinding") && lifecycle.includes("redacted owned Vault key identity"), "Vault fixture seeds and binds only a redacted key identity");
assert(lifecycle.includes("cleanupBrowserTeachEvidenceFixture") && lifecycle.includes("cleanupOwnedVaultBinding") && lifecycle.includes("lockOwnedIsolatedVault"), "driver deletes exact owned evidence/key and returns the disposable Vault to locked state for candidate teardown");
assert(fixture.includes('selector: "#shellx-release-teach-input"') && fixture.includes('"/browser/flight-recorder/export"'), "Flight Recorder evidence includes one redacted owned input action before export");

console.log("Browser Teach installed-driver source checks passed (39 assignments; native approval boundary retained)");
