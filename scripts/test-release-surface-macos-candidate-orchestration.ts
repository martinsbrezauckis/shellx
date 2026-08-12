import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  createReleaseSurfaceMacosNondecreasingClock,
  RELEASE_SURFACE_MACOS_QUICK_START_LINK_TARGETS,
  RELEASE_SURFACE_MACOS_RENDERED_LINK_TARGETS,
} from "./lib/release-surface-macos-health-collector";

const root = resolve(import.meta.dirname, "..");
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const prepareSource = readFileSync(join(root, "scripts/prepare-release-surface-macos-candidate.ts"), "utf8");
const runSource = readFileSync(join(root, "scripts/run-release-surface-macos-candidate.ts"), "utf8");
const finalizeSource = readFileSync(join(root, "scripts/finalize-release-surface-macos-candidate.ts"), "utf8");
const healthSource = readFileSync(join(root, "scripts/lib/release-surface-macos-health-collector.ts"), "utf8");
const installedInputSource = readFileSync(join(root, "scripts/lib/release-surface-installed-input-client.ts"), "utf8");
const aboutSource = readFileSync(join(root, "src/components/settings/AboutTab.tsx"), "utf8");
const markdownSource = readFileSync(join(root, "src/lib/markdown-links.tsx"), "utf8");
const observationSource = readFileSync(join(root, "src/lib/debug-element-observation.ts"), "utf8");
const boundedObservationSource = readFileSync(join(root, "scripts/lib/release-surface-bounded-observation.ts"), "utf8");
const overlaySource = readFileSync(join(root, "src/components/DebugHighlightOverlay.tsx"), "utf8");
const rustDebugSource = readFileSync(join(root, "src-tauri/src/debug_api.rs"), "utf8");

const allTargets = [
  ...RELEASE_SURFACE_MACOS_RENDERED_LINK_TARGETS,
  ...RELEASE_SURFACE_MACOS_QUICK_START_LINK_TARGETS,
];
const clockValues = [
  new Date("2026-08-03T01:00:00.100Z"),
  new Date("2026-08-03T01:00:00.050Z"),
  new Date("2026-08-03T01:00:00.200Z"),
];
const clock = createReleaseSurfaceMacosNondecreasingClock(() => clockValues.shift()!);
assert.deepEqual([clock(), clock(), clock()].map((value) => value.toISOString()), [
  "2026-08-03T01:00:00.100Z",
  "2026-08-03T01:00:00.100Z",
  "2026-08-03T01:00:00.200Z",
]);
assert.throws(
  () => createReleaseSurfaceMacosNondecreasingClock(() => new Date(Number.NaN))(),
  /clock returned an invalid date/,
);
assert.equal(allTargets.length, 7, "macOS health scans five About links and two quick-start links");
assert.equal(new Set(allTargets.map((target) => target.surfaceName)).size, 6);
for (const target of allTargets) {
  assert.match(target.href, /^https:\/\//);
  assert(
    inventory.items.some((item) => item.kind === "ui-control"
      && item.name === target.surfaceName
      && item.platforms.includes("macos-installed")),
    `macOS rendered link target remains present in inventory: ${target.surfaceName}`,
  );
}
assert.equal(aboutSource.match(/data-shellx-release-observe="href"/g)?.length, 5);
assert(markdownSource.includes('data-shellx-release-observe="href"'));
assert(markdownSource.includes('"quick-start-releases"'));
assert(markdownSource.includes('"quick-start-issues"'));
assert(observationSource.includes('"href"'));
assert(observationSource.includes("element instanceof HTMLAnchorElement"));
assert(boundedObservationSource.includes('field === "href"'));
assert(boundedObservationSource.includes("returned a non-HTTPS href"));
assert(overlaySource.includes('message: "matched element is outside the visible viewport"'));
assert(overlaySource.includes("observation,"), "offscreen mounted anchors retain only their declared observation");
assert(rustDebugSource.includes("Href,"));
assert(rustDebugSource.includes("normalized.len() == 13"));

assert(prepareSource.includes('process.platform !== "darwin"'));
assert(prepareSource.includes('"--candidate-stage"'));
assert(prepareSource.includes('"immediately-before-publish"'));
assert(prepareSource.includes("prepareReleaseSurfaceRunProfile"));
assert(prepareSource.includes("create-release-surface-candidate-attestation.ts"));
assert(prepareSource.includes("build-release-surface-macos-native-input.ts"));
assert(prepareSource.includes("child.unref()"));
assert(prepareSource.includes('"/usr/bin/osascript"'));
assert(prepareSource.includes('first process whose unix id is ${processId}'));
assert(prepareSource.includes('"return frontmost of candidateProcess"'));
assert(prepareSource.includes('method: "system-events-frontmost-by-pid"'));
assert(prepareSource.includes("nextAvailableFailurePath"));
assert(!prepareSource.includes("AXIsProcessTrustedWithOptions"), "preparation never requests a privacy prompt");

assert(runSource.includes('process.platform !== "darwin"'));
assert(runSource.includes("prove-release-surface-macos-native-input-binding.ts"));
assert(runSource.includes("validateFrozenCandidateInputs"));
assert(runSource.includes("proof.status === 3"), "Accessibility remains an explicit resumable prerequisite");
assert(runSource.includes("startReleaseSurfaceMacosHealthCollector"));
assert(runSource.includes("createReleaseSurfaceMacosInstalledInputSession"));
assert(runSource.includes("runReleaseSurfaceDrivers"));
assert(runSource.includes("collectReleaseSurfaceProviderRouteBatch"));
assert(runSource.includes("healthCollector?.beginShutdown()"));
assert(runSource.includes('executionWindow: targetedClosure ? "targeted-post-matrix"'));
assert(runSource.includes('readArgs(args, "--surface-id")'));
assert(runSource.includes("selectedSurfaceIds"));
assert(runSource.includes('...(targetedClosure ? ["--candidate-source-commit", sourceCommit] : [])'));
assert(runSource.includes("const providerRoutes = targetedClosure"));
assert(runSource.includes("finalize-release-surface-macos-candidate.ts"));
assert(runSource.includes("writeScenarioReport"));
assert(runSource.includes("macos-native-candidate-finalizer"));
assert(runSource.includes("macos-run-failure-cleanup-"));
assert(runSource.includes('preparation.activation.method !== "system-events-frontmost-by-pid"'));
assert(runSource.includes("preparation.activation.processId !== candidate.process.pid"));
assert(runSource.includes("macOS durable evidence paths must be distinct"));
assert(runSource.includes("nextAvailableFailurePath"));
assert(runSource.includes("durable macOS candidate evidence must remain outside the disposable profile"));
assert(!runSource.includes("nativeWebDriver:"), "macOS orchestration never fabricates a WebDriver session");
assert(finalizeSource.includes("resolveReleaseSurfaceControllerProvenance"));
assert(finalizeSource.includes("targetedClosure !== Boolean(candidateSourceCommitArg)"));
assert(finalizeSource.includes("driver manifest controller delta does not match"));

assert(healthSource.includes("new WebSocket(value)"));
assert(healthSource.includes('event.payload.warning === "lagged"'));
assert(healthSource.includes("MAX_CAPTURED_EVENTS"));
assert(healthSource.includes("macOS rendered-link cleanup was incomplete"));
assert(healthSource.includes('event.kind === "renderer-error"'));
assert(healthSource.includes("SHELLX_RELEASE_RENDERER_ERROR_"));
assert(healthSource.includes("final-surface-renderer-stack"));
assert(healthSource.includes("expectedLinkSurfaceIds"));
assert(healthSource.includes("validateReleaseSurfaceHealthEvidence"));
assert(installedInputSource.includes("createReleaseSurfaceMacosInstalledInputSession"));
assert(installedInputSource.includes("validateReleaseSurfaceMacosNativeInputBinding"));
assert(installedInputSource.includes("allowHiddenObservation"));
assert(installedInputSource.includes('result.message === "matched element is outside the visible viewport"'));

console.log("Release surface macOS candidate preparation, health, orchestration, and fail-closed source contracts passed");
