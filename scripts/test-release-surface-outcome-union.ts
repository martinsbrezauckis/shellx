import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeReleaseSurfaceOutcomeUnion,
  type ReleaseSurfaceOutcomeSlice,
} from "./lib/release-surface-outcome-union";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { composeValidatedReleaseSurfaceReceiptUnion } from "./lib/release-surface-receipt-union";
import type { FinalSurfaceReceipt } from "./lib/release-surface-receipts";
import type { FinalSurfaceContract } from "./lib/release-surface-receipts";
import { composeFinalSurfaceReceiptFromUnionManifest } from "./lib/release-surface-union-manifest";

const sourceCommit = "a".repeat(40);
const inventory = {
  schema: "shellx/release-surface-inventory@4",
  generatedAt: "2026-08-16T00:00:00.000Z",
  digest: "b".repeat(64),
  items: [surface("surface:a"), surface("surface:b")],
} as unknown as ReleaseSurfaceInventory;
const plan = {
  schema: "shellx/final-surface-driver-plan@7",
  generatedAt: "2026-08-16T00:00:00.000Z",
  inventoryDigest: inventory.digest,
  drivers: [],
  assignments: [assignment("surface:a"), assignment("surface:b")],
} as unknown as FinalSurfaceDriverPlan;
const discovery: ReleaseSurfaceOutcomeSlice = {
  sourceId: "discovery-01",
  sourceKind: "interrupted-discovery",
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  inventoryDigest: inventory.digest,
  startedAt: "2026-08-16T00:00:00.000Z",
  completedAt: "2026-08-16T00:10:00.000Z",
  outcomes: [outcome("surface:a", "pass"), outcome("surface:b", "fail")],
};
const targeted: ReleaseSurfaceOutcomeSlice = {
  ...discovery,
  sourceId: "targeted-01",
  sourceKind: "targeted-closure",
  startedAt: "2026-08-16T00:20:00.000Z",
  completedAt: "2026-08-16T00:21:00.000Z",
  outcomes: [outcome("surface:b", "pass")],
};

const union = composeReleaseSurfaceOutcomeUnion({
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  slices: [discovery, targeted],
});
assert.deepEqual(union.selections.map((row) => [row.id, row.sourceId]), [
  ["surface:a", "discovery-01"],
  ["surface:b", "targeted-01"],
]);
assert.deepEqual(union.retainedFailures, [{
  sourceId: "discovery-01",
  id: "surface:b",
  driverId: "fixture-driver",
  evidenceId: "report:surface:b",
  cleanupEvidenceId: "cleanup:surface:b",
}]);

assert.throws(() => composeReleaseSurfaceOutcomeUnion({
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  slices: [discovery],
}), /latest evidence .* is not passing/, "an unresolved red cannot be hidden by the union");

assert.throws(() => composeReleaseSurfaceOutcomeUnion({
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  slices: [{ ...targeted, outcomes: [outcome("surface:b", "pass")] }],
}), /missing 1 outcomes/, "a targeted slice cannot pretend to be full coverage");

assert.throws(() => composeReleaseSurfaceOutcomeUnion({
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  slices: [discovery, {
    ...targeted,
    startedAt: "2026-08-16T00:08:00.000Z",
    completedAt: "2026-08-16T00:09:00.000Z",
  }],
}), /latest evidence .* is not passing/, "chronologically older targeted evidence cannot supersede a later red");

assert.throws(() => composeReleaseSurfaceOutcomeUnion({
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  slices: [discovery, {
    ...targeted,
    outcomes: [{ ...outcome("surface:b", "pass"), oracleId: "forged" }],
  }],
}), /drifted from the frozen plan/, "targeted evidence cannot rewrite the frozen oracle");

const scenarioReceipt: FinalSurfaceReceipt = {
  schema: "shellx/final-surface-receipt@4",
  mode: "final-frozen-candidate",
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  inventoryDigest: inventory.digest,
  startedAt: targeted.startedAt,
  completedAt: targeted.completedAt,
  artifact: { basename: "shellx.deb", sha256: "c".repeat(64), signatureStatus: "digest-verified" },
  evidenceArtifacts: [
    evidence("driver-report"),
    evidence("driver-cleanup"),
    evidence("scenario"),
  ],
  transports: [{ id: "local-native", status: "pass", evidence: "scenario" }],
  providers: [{ id: "grok", status: "pass", version: "1.0.0", evidence: "scenario" }],
  providerRoutes: [{
    id: "local-native:grok",
    transportId: "local-native",
    providerId: "grok",
    status: "pass",
    evidenceMode: "identity-only",
    version: "1.0.0",
    executableSha256: "d".repeat(64),
    evidence: "scenario",
  }],
  health: { startup: "pass", shutdown: "pass", brokenLinks: 0, unexpectedConsoleErrors: 0, evidence: "scenario" },
  outcomes: [{
    id: "surface:b",
    expectedEffect: "effect:surface:b",
    oracleId: "oracle:surface:b",
    present: "pass",
    invoke: "pass",
    effect: "pass",
    cleanup: "pass",
    evidence: "driver-report",
    cleanupEvidence: "driver-cleanup",
    observedEffect: "bounded targeted effect passed",
  }],
};
const finalUnion = composeValidatedReleaseSurfaceReceiptUnion({
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  scenarioSourceId: "targeted-01",
  slices: [
    {
      kind: "recovered",
      recovery: {
        slice: discovery,
        evidenceArtifacts: [
          evidence("report:surface:a"),
          evidence("cleanup:surface:a"),
          evidence("report:surface:b"),
          evidence("cleanup:surface:b"),
        ],
        artifact: { basename: "shellx.deb", sha256: "c".repeat(64), bytes: 100 },
        signatureStatus: "digest-verified",
        incompleteDriverIds: ["fixture-incomplete"],
      },
    },
    {
      kind: "receipt",
      value: { sourceId: "targeted-01", sourceKind: "targeted-closure", receipt: scenarioReceipt },
    },
  ],
});
assert.deepEqual(finalUnion.outcomes.map((row) => [row.id, row.evidence]), [
  ["surface:a", "discovery-01:report:surface:a"],
  ["surface:b", "targeted-01:driver-report"],
]);
assert(finalUnion.evidenceArtifacts.some((row) => row.id === "discovery-01:report:surface:b"));
assert.equal(finalUnion.health.evidence, "targeted-01:scenario");
assert.equal(finalUnion.transports[0]?.evidence, "targeted-01:scenario");

assert.throws(() => composeValidatedReleaseSurfaceReceiptUnion({
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  scenarioSourceId: "targeted-01",
  slices: [{
    kind: "receipt",
    value: {
      sourceId: "targeted-01",
      sourceKind: "targeted-closure",
      receipt: { ...scenarioReceipt, artifact: { ...scenarioReceipt.artifact, sha256: "e".repeat(64) } },
    },
  }],
}), /missing 1 outcomes/, "a sealed targeted receipt cannot masquerade as a complete final receipt");

const manifestFixtureRoot = mkdtempSync(join(tmpdir(), "shellx-union-manifest-"));
const manifestFixturePath = join(manifestFixtureRoot, "union.json");
writeFileSync(manifestFixturePath, `${JSON.stringify({
  schema: "shellx/release-surface-union-manifest@1",
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  inventoryDigest: inventory.digest,
  scenarioSourceId: "targeted-01",
  sources: [
    {
      sourceId: "discovery-01",
      sourceKind: "interrupted-discovery",
      driverRunDir: "../escape",
      orchestration: "discovery/orchestration.json",
      lifecycle: "discovery/lifecycle.json",
      profileCleanup: "discovery/profile-cleanup.json",
      candidateAttestation: "discovery/candidate.json",
      signatureReceipt: "discovery/signature.json",
      installationReceipt: "discovery/installation.json",
    },
    {
      sourceId: "targeted-01",
      sourceKind: "targeted-closure",
      driverRunDir: "targeted/driver-run",
      scenarioReport: "targeted/scenario.json",
      signatureReceipt: "targeted/signature.json",
      candidateAttestation: "targeted/candidate.json",
      candidateTeardown: "targeted/teardown.json",
      installationReceipt: "targeted/installation.json",
    },
  ],
}, null, 2)}\n`, "utf8");
assert.throws(() => composeFinalSurfaceReceiptFromUnionManifest({
  receiptsDir: manifestFixtureRoot,
  manifestPath: manifestFixturePath,
  contract: {} as FinalSurfaceContract,
  inventory,
  driverPlan: plan,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.60",
  rootDir: process.cwd(),
}), /canonical relative path/, "union manifests cannot escape the private evidence root");

console.log("Release surface interrupted outcome union tests passed");

function surface(id: string): ReleaseSurfaceInventory["items"][number] {
  return {
    id,
    kind: "shellx-command",
    name: id,
    source: "scripts/fixture.ts",
    platforms: ["linux-installed"],
    delivery: "installed-app",
  };
}

function assignment(surfaceId: string): FinalSurfaceDriverPlan["assignments"][number] {
  return {
    surfaceId,
    driverId: "fixture-driver",
    fixtureId: `fixture:${surfaceId}`,
    expectedEffect: `effect:${surfaceId}`,
    oracleId: `oracle:${surfaceId}`,
    cleanupId: `cleanup:${surfaceId}`,
  };
}

function outcome(id: string, verdict: "pass" | "fail") {
  return {
    id,
    driverId: "fixture-driver",
    expectedEffect: `effect:${id}`,
    oracleId: `oracle:${id}`,
    present: "pass" as const,
    invoke: "pass" as const,
    effect: verdict,
    cleanup: "pass" as const,
    observedEffect: verdict === "pass" ? "bounded effect passed" : "bounded effect failed",
    evidenceId: `report:${id}`,
    cleanupEvidenceId: `cleanup:${id}`,
  };
}

function evidence(id: string): FinalSurfaceReceipt["evidenceArtifacts"][number] {
  return { id, relativePath: `${id.replaceAll(":", "-")}.json`, sha256: "f".repeat(64), bytes: 10 };
}
