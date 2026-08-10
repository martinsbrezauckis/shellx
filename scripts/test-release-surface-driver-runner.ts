import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_SURFACE_INVENTORY_SCHEMA,
  type ReleasePlatform,
  type ReleaseSurfaceInventory,
} from "./lib/release-surface-inventory";
import {
  FINAL_SURFACE_DRIVER_PLAN_SCHEMA,
  type FinalSurfaceDriverPlan,
} from "./lib/release-surface-driver-plan";
import {
  RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
  releaseSurfaceDriverRunFailedDriverIds,
  resolveReleaseSurfaceDriverSelection,
  runReleaseSurfaceDrivers,
} from "./lib/release-surface-driver-runner";
import { composeFinalSurfaceReceipt } from "./lib/release-surface-receipt-composer";
import { createReleaseSurfaceHealthEvidence } from "./create-release-surface-health-evidence";
import {
  loadFinalSurfaceContract,
  type FinalSurfaceRequiredProviderRoute,
} from "./lib/release-surface-receipts";
import {
  RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
  RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID,
  RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA,
  releaseSurfaceProviderRouteId,
  type ReleaseSurfaceProviderRoute,
  type ReleaseSurfaceScenarioReport,
} from "./lib/release-surface-scenario-report";
import {
  RELEASE_SURFACE_PROVIDER_ROUTE_COLLECTOR_ID,
  RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA,
  deriveReleaseSurfaceProviderNormalizedEvents,
  type ReleaseSurfaceProviderRouteEvidence,
} from "./lib/release-surface-provider-route-evidence";
import {
  RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
  type ReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./lib/release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_HEALTH_COLLECTOR_ID,
  RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA,
  type ReleaseSurfaceHealthEvidence,
} from "./lib/release-surface-health-evidence";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";
import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import {
  collectReleaseSurfacePosixNativeRuntime,
  type ReleaseSurfacePosixNativeRuntime,
} from "./lib/release-surface-posix-native-runtime";
import {
  RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME,
  releaseSurfaceLinuxPathDigest,
} from "./lib/release-surface-linux-deb-installation";
import { createReleaseSurfaceCandidateTeardownReceipt } from "./lib/release-surface-candidate-teardown";
import {
  RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA,
  type ReleaseSurfaceRunProfileCleanupReceipt,
} from "./lib/release-surface-run-profile";
import {
  releaseSurfaceControllerModuleSpecifier,
  releaseSurfaceControllerNodeArguments,
  releaseSurfaceControllerTsxLoaderPath,
  releaseSurfaceControllerTsxLoaderSpecifier,
} from "./lib/release-surface-controller-binding";
import {
  RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA,
  type ReleaseSurfaceWebDriverLifecycleReceipt,
} from "./lib/release-surface-webdriver-lifecycle";

const root = resolve(import.meta.dirname, "..");
for (const script of [
  "scripts/run-release-surface-webdriver-candidate.ts",
  "scripts/run-release-surface-macos-candidate.ts",
]) {
  const source = readFileSync(resolve(root, script), "utf8");
  assert.match(source, /readArgs\(args, "--driver-id"\)/, `${script} must accept targeted driver selectors`);
  assert.match(source, /targeted-post-matrix/, `${script} must require the targeted execution window`);
  assert.match(source, /selectedDriverIds/, `${script} must pass targeted selectors to the driver runner`);
}
{
  const source = readFileSync(resolve(root, "scripts/prepare-release-surface-macos-candidate.ts"), "utf8");
  assert.match(source, /readArgs\(values, "--driver-id"\)/, "macOS preparation must recognize targeted driver selectors");
  assert.match(source, /targeted-post-matrix/, "macOS preparation must allow only the targeted execution window for a closure run");
}
assert.equal(
  fileURLToPath(releaseSurfaceControllerTsxLoaderSpecifier()),
  releaseSurfaceControllerTsxLoaderPath(),
  "the executable tsx loader must be passed to Node as a cross-platform file URL",
);
assert.equal(
  fileURLToPath(releaseSurfaceControllerModuleSpecifier(resolve(root, "scripts/run-release-surface-drivers.ts"))),
  resolve(root, "scripts/run-release-surface-drivers.ts"),
  "release controller entrypoints must round-trip through a cross-platform file URL",
);
assert.deepEqual(
  releaseSurfaceControllerNodeArguments(resolve(root, "scripts/run-release-surface-drivers.ts"), ["--probe"]),
  [
    "--import",
    releaseSurfaceControllerTsxLoaderSpecifier(),
    "--eval",
    "const moduleUrl = process.argv[1]; process.argv[1] = require('node:url').fileURLToPath(moduleUrl); import(moduleUrl)",
    releaseSurfaceControllerModuleSpecifier(resolve(root, "scripts/run-release-surface-drivers.ts")),
    "--probe",
  ],
  "Node must import cross-platform controller file URLs through an eval bootstrap while preserving controller arguments",
);
if (process.platform !== "linux") {
  console.log("SKIP Linux installed-driver integration fixture: portable controller bindings passed; a native Linux runtime is required for the remaining fixture");
  process.exit(0);
}
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureTimeShiftMs = Date.now() - Date.parse("2026-07-28T18:00:00.000Z") - 60_000;
const fixtureTimestamp = (value: string): string => new Date(Date.parse(value) + fixtureTimeShiftMs).toISOString();
const fixtureTimestampMs = (value: string): number => Date.parse(value) + fixtureTimeShiftMs;
const contract = loadFinalSurfaceContract(resolve(root, "release", "surface-contract.json"));
const inventory: ReleaseSurfaceInventory = {
  schema: RELEASE_SURFACE_INVENTORY_SCHEMA,
  platforms: ["windows-installed", "macos-installed", "linux-installed"],
  digest: "a".repeat(64),
  counts: {
    "tauri-command": 2,
    "debug-api-route": 0,
    "host-mcp-tool": 0,
    "browser-cli-command": 0,
    "palette-action": 0,
    "keyboard-shortcut": 0,
    "shellx-command": 0,
    "ui-debug-surface": 0,
    "ui-control": 0,
  },
  unresolvedInteractiveControls: 0,
  copyDerivedInteractiveControls: 0,
  uiDriverFamilyAccounting: {
    selection: 0,
    disclosure: 0,
    toggle: 0,
    "text-entry": 0,
    choice: 0,
    range: 0,
    "file-picker": 0,
    activation: 0,
    "static-marker": 0,
    "dynamic-marker": 0,
  },
  occurrenceAccounting: {
    uiControls: { candidates: 0, excludedNonActions: 0, finiteVariantInstances: 0, inventoried: 0 },
    uiDebugSurfaces: { candidates: 0, finiteVariantInstances: 0, inventoried: 0 },
  },
  items: [
    {
      id: "tauri-command:fixture",
      kind: "tauri-command",
      name: "fixture",
      source: "fixture.rs",
      platforms: ["windows-installed", "macos-installed", "linux-installed"],
      delivery: "installed-app",
    },
    {
      id: "tauri-command:windows-only-fixture",
      kind: "tauri-command",
      name: "windows-only-fixture",
      source: "fixture.rs",
      platforms: ["windows-installed"],
      delivery: "installed-app",
    },
  ],
};
const plan: FinalSurfaceDriverPlan = {
  schema: FINAL_SURFACE_DRIVER_PLAN_SCHEMA,
  mode: "final-frozen-candidate",
  inventoryDigest: inventory.digest,
  releaseReady: true,
  drivers: [{
    id: "fixture-installed",
    kind: "tauri-command",
    entrypoint: "scripts/fixtures/release-surface-driver-fixture.ts",
    platforms: {
      "windows-installed": "ready",
      "macos-installed": "ready",
      "linux-installed": "ready",
    },
  }],
  assignments: [
    {
      surfaceId: "tauri-command:fixture",
      driverId: "fixture-installed",
      fixtureId: "fixture:isolated-profile",
      expectedEffect: "fixture returned its isolated result",
      oracleId: "fixture:isolated-result",
      cleanupId: "tauri:discard-with-candidate-profile",
    },
    {
      surfaceId: "tauri-command:windows-only-fixture",
      driverId: "fixture-installed",
      fixtureId: "fixture:isolated-profile",
      expectedEffect: "Windows-only fixture returned its isolated result",
      oracleId: "fixture:isolated-result",
      cleanupId: "tauri:discard-with-candidate-profile",
    },
  ],
};
assert.deepEqual(
  resolveReleaseSurfaceDriverSelection(plan, "linux-installed", ["fixture-installed"]),
  ["fixture-installed"],
);
assert.throws(
  () => resolveReleaseSurfaceDriverSelection(plan, "linux-installed", []),
  /at least one non-empty driver id/,
);
assert.throws(
  () => resolveReleaseSurfaceDriverSelection(
    plan,
    "linux-installed",
    ["fixture-installed", "fixture-installed"],
  ),
  /must be unique/,
);
assert.throws(
  () => resolveReleaseSurfaceDriverSelection(plan, "linux-installed", ["missing-driver"]),
  /names unavailable linux-installed drivers/,
);

const temp = mkdtempSync(join(tmpdir(), "shellx-final-driver-runner-"));
let runtimeServer: ChildProcess | null = null;
try {
  const artifactPath = join(temp, `shellx_${releaseSurfaceFixtureVersion}_amd64.deb`);
  const signatureReceiptPath = join(temp, "signature.json");
  const candidateAttestationPath = join(temp, "candidate-attestation.json");
  const installationReceiptPath = join(temp, "installation.json");
  const teardownRunId = "0123456789abcdef";
  const teardownProfilePath = join(temp, `shellx-final-webdriver-${teardownRunId}`);
  const runtimeTokenPath = join(teardownProfilePath, ".shellx", "shellxagent.token");
  const runtimeStatePath = join(temp, "runtime-server.json");
  const outputDir = join(temp, "evidence");
  const installRoot = join(temp, "shellx-final-install-runner");
  const installedPayloadPath = join(installRoot, "usr", "bin", "shellx");
  const mutationProbePath = join(installRoot, "usr", "share", "shellx", "fixture-data.txt");
  copyFileSync(process.execPath, artifactPath);
  mkdirSync(join(installRoot, "usr", "bin"), { recursive: true });
  mkdirSync(join(installRoot, "usr", "share", "shellx"), { recursive: true });
  copyFileSync(process.execPath, installedPayloadPath);
  chmodSync(installedPayloadPath, 0o755);
  writeFileSync(mutationProbePath, "stable installed fixture data", "utf8");
  mkdirSync(join(teardownProfilePath, ".shellx"), { recursive: true });
  writeFileSync(runtimeTokenPath, "fixture-runtime-token-that-is-long-enough", { encoding: "utf8", mode: 0o600 });
  const artifactBytes = statSync(artifactPath).size;
  const artifactSha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  const signatureReceiptIdentity = writeJsonIdentity(signatureReceiptPath, {
    schema: "shellx/release-surface-signature-receipt@2",
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    createdAt: fixtureTimestamp("2026-07-28T17:59:00.000Z"),
    artifact: {
      basename: basename(artifactPath),
      sha256: artifactSha256,
      bytes: artifactBytes,
    },
    status: "digest-verified",
    nativeVerification: {
      kind: "artifact-digest",
      algorithm: "sha256",
      sha256: artifactSha256,
    },
    checks: contract.platforms["linux-installed"].requiredSignatureChecks.map((id) => ({
      id,
      status: "pass",
      observed: `${id} passed on the installed Linux candidate`,
    })),
  });
  runtimeServer = spawn(installedPayloadPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-runtime-server-fixture.ts"),
    "--token-file", runtimeTokenPath,
    "--state-out", runtimeStatePath,
    "--instance-id", "fixture-instance-0001",
    "--process-id", "self",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const runtimeState = await waitForRuntimeState(runtimeStatePath, runtimeServer);
  const runtimeBase = `http://127.0.0.1:${runtimeState.port}`;
  const posixNativeRuntime = collectReleaseSurfacePosixNativeRuntime({
    platform: "linux",
    processId: runtimeState.processId,
    port: runtimeState.port,
  });
  posixNativeRuntime.observedAt = fixtureTimestamp("2026-07-28T17:59:29.000Z");
  const parsedInstallationReceipt = installationReceipt(
    "linux-installed",
    artifactSha256,
    installedPayloadPath,
    installRoot,
    artifactBytes,
    artifactPath,
    signatureReceiptIdentity,
  );
  const installationReceiptIdentity = writeJsonIdentity(installationReceiptPath, parsedInstallationReceipt);
  writeFileSync(candidateAttestationPath, `${JSON.stringify(candidateAttestation(
    "linux-installed",
    artifactSha256,
    installedPayloadPath,
    installationReceiptIdentity,
    parsedInstallationReceipt.payloadManifest.manifestSha256,
    runtimeBase,
    runtimeTokenPath,
    runtimeState.processId,
    artifactBytes,
    posixNativeRuntime,
  ), null, 2)}\n`, "utf8");
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir: join(installRoot, "evidence"),
  }), /output must be outside the installed payload root/, "driver evidence must not invalidate the measured installation root");
  const result = runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir,
  });
  assert.equal(result.schema, RELEASE_SURFACE_DRIVER_RUN_SCHEMA);
  assert.equal(result.driverReports.length, 1);
  assert.equal(result.driverReports[0]?.outcomes, 1);
  assert.equal(result.artifact.sha256.length, 64);
  assert.equal(result.signatureReceipt.sha256.length, 64);
  const persisted = JSON.parse(readFileSync(join(outputDir, "run-manifest.json"), "utf8"));
  assert.equal(persisted.inventoryDigest, inventory.digest);

  const discoveryInventory: ReleaseSurfaceInventory = {
    ...structuredClone(inventory),
    digest: "b".repeat(64),
    counts: { ...inventory.counts, "tauri-command": 2 },
    items: [
      { ...inventory.items[0]!, platforms: ["linux-installed"] },
      {
        id: "tauri-command:followup-fixture",
        kind: "tauri-command",
        name: "followup-fixture",
        source: "fixture.rs",
        platforms: ["linux-installed"],
        delivery: "installed-app",
      },
    ],
  };
  const discoveryPlan: FinalSurfaceDriverPlan = {
    schema: FINAL_SURFACE_DRIVER_PLAN_SCHEMA,
    mode: "final-frozen-candidate",
    inventoryDigest: discoveryInventory.digest,
    releaseReady: true,
    drivers: [
      {
        id: "fixture-a-failing-installed",
        kind: "tauri-command",
        entrypoint: "scripts/fixtures/release-surface-driver-failing-fixture.ts",
        platforms: { "linux-installed": "ready" },
      },
      plan.drivers[0]!,
    ],
    assignments: [
      {
        surfaceId: "tauri-command:fixture",
        driverId: "fixture-a-failing-installed",
        fixtureId: "fixture:expected-failure",
        expectedEffect: "fixture records one synthetic discovery finding",
        oracleId: "fixture:expected-failure",
        cleanupId: "tauri:discard-with-candidate-profile",
      },
      {
        surfaceId: "tauri-command:followup-fixture",
        driverId: "fixture-installed",
        fixtureId: "fixture:isolated-profile",
        expectedEffect: "later independent fixture still runs",
        oracleId: "fixture:isolated-result",
        cleanupId: "tauri:discard-with-candidate-profile",
      },
    ],
  };
  const discoveryOutputDir = join(temp, "discovery-evidence");
  const discovery = runReleaseSurfaceDrivers({
    rootDir: root,
    plan: discoveryPlan,
    inventory: discoveryInventory,
    contract,
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir: discoveryOutputDir,
  });
  assert.deepEqual(
    discovery.driverReports.map((report) => report.driverId),
    ["fixture-a-failing-installed", "fixture-installed"],
    "a red section must not prevent the later independent section from producing durable evidence",
  );
  assert.deepEqual(
    releaseSurfaceDriverRunFailedDriverIds(discovery, discoveryOutputDir),
    ["fixture-a-failing-installed"],
    "the completed discovery manifest must retain its exact failed section",
  );
  const targetedOutputDir = join(temp, "targeted-closure-evidence");
  const targeted = runReleaseSurfaceDrivers({
    rootDir: root,
    plan: discoveryPlan,
    inventory: discoveryInventory,
    contract,
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir: targetedOutputDir,
    selectedDriverIds: ["fixture-installed"],
  });
  assert.deepEqual(targeted.targetedClosure, { driverIds: ["fixture-installed"] });
  assert.deepEqual(
    targeted.driverReports.map((report) => report.driverId),
    ["fixture-installed"],
  );
  assert.deepEqual(releaseSurfaceDriverRunFailedDriverIds(targeted, targetedOutputDir), []);

  const lifecyclePath = join(temp, "webdriver-lifecycle.json");
  const profileCleanupPath = join(temp, "profile-cleanup.json");
  const candidateTeardownPath = join(temp, "candidate-teardown.json");
  const manifestCompletedMs = Date.parse(result.completedAt);
  const lifecycle: ReleaseSurfaceWebDriverLifecycleReceipt = {
    schema: RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA,
    mode: "final-frozen-candidate",
    status: "pass",
    startedAt: result.startedAt,
    completedAt: new Date(manifestCompletedMs + 1).toISOString(),
    driver: {
      basename: "tauri-driver",
      sha256: "8".repeat(64),
      bytes: 100,
      launchPath: "/usr/bin/tauri-driver",
      argsPrefixSha256: "9".repeat(64),
      processId: 5000,
      base: "http://127.0.0.1:30125",
      nativePort: 30126,
    },
    application: {
      basename: basename(installedPayloadPath),
      sha256: artifactSha256,
      bytes: artifactBytes,
      launchPath: installedPayloadPath,
    },
    driverLog: { retainedSha256: "0".repeat(64), retainedBytes: 0, observedBytes: 0, truncated: false },
    session: { created: true, sessionIdSha256: "1".repeat(64), workCompleted: true },
    cleanup: {
      sessionDeleted: "pass",
      driverStopped: "pass",
      sessionDelete: {
        requestedAt: result.completedAt,
        completedAt: new Date(manifestCompletedMs + 1).toISOString(),
      },
    },
  };
  const lifecycleIdentity = writeJsonIdentity(lifecyclePath, lifecycle);
  const profileCleanup: ReleaseSurfaceRunProfileCleanupReceipt = {
    schema: RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA,
    mode: "final-frozen-candidate",
    status: "pass",
    platform: "linux-installed",
    runId: teardownRunId,
    startedAt: new Date(manifestCompletedMs + 2).toISOString(),
    completedAt: new Date(manifestCompletedMs + 3).toISOString(),
    profilePathSha256: createHash("sha256").update(teardownProfilePath).digest("hex"),
    application: {
      processId: runtimeState.processId,
      alreadyStopped: true,
      identityVerifiedBeforeStop: false,
      forcedStop: false,
      processCountAfter: 0,
    },
    nativeDriver: { configured: false, forcedStopCount: 0, processCountAfter: 0 },
    listeners: { debugCountAfter: 0, mcpCountAfter: 0 },
    profile: { markerVerified: true, removed: true },
  };
  const profileCleanupIdentity = writeJsonIdentity(profileCleanupPath, profileCleanup);
  const candidateIdentity = readFileIdentity(candidateAttestationPath);
  const manifestPath = join(outputDir, "run-manifest.json");
  const teardown = createReleaseSurfaceCandidateTeardownReceipt({
    platform: "linux-installed",
    runId: teardownRunId,
    candidateAttestation: JSON.parse(readFileSync(candidateAttestationPath, "utf8")),
    candidateAttestationIdentity: candidateIdentity,
    driverRunManifest: result,
    driverRunManifestIdentity: readFileIdentity(manifestPath),
    webdriverLifecycle: lifecycle,
    webdriverLifecycleIdentity: lifecycleIdentity,
    profileCleanup,
    profileCleanupIdentity,
  });
  writeJsonIdentity(candidateTeardownPath, teardown);

  const scenarioPath = join(temp, "linux-scenario.json");
  const fixtureCandidate = JSON.parse(
    readFileSync(candidateAttestationPath, "utf8"),
  ) as ReleaseSurfaceCandidateAttestation;
  const healthDraftPath = join(temp, "scenario-health-draft.json");
  const healthEvidencePath = join(temp, "scenario-health.json");
  writeFileSync(healthDraftPath, `${JSON.stringify(fixtureHealthEvidence(fixtureCandidate), null, 2)}\n`, "utf8");
  createReleaseSurfaceHealthEvidence({
    draftPath: healthDraftPath,
    candidateAttestationPath,
    scenarioStartedAt: fixtureTimestamp("2026-07-28T18:00:02.000Z"),
    scenarioCompletedAt: fixtureTimestamp("2026-07-28T18:00:03.000Z"),
    outputPath: healthEvidencePath,
    repositoryRoot: root,
    runGit: fixtureHealthGit,
  });
  const healthEvidenceIdentity = readFileIdentity(healthEvidencePath);
  assert.throws(() => createReleaseSurfaceHealthEvidence({
    draftPath: healthDraftPath,
    candidateAttestationPath,
    scenarioStartedAt: fixtureTimestamp("2026-07-28T18:00:02.000Z"),
    scenarioCompletedAt: fixtureTimestamp("2026-07-28T18:00:03.000Z"),
    outputPath: healthEvidencePath,
    repositoryRoot: root,
    runGit: fixtureHealthGit,
  }), /EEXIST/, "health evidence creation must not overwrite an existing artifact");
  const scenario: ReleaseSurfaceScenarioReport = {
    schema: RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA,
    mode: "final-frozen-candidate",
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifactSha256: result.artifact.sha256,
    startedAt: fixtureTimestamp("2026-07-28T18:00:02.000Z"),
    completedAt: fixtureTimestamp("2026-07-28T18:00:03.000Z"),
    providerRoutes: fixtureProviderRoutes(
      temp,
      "linux-installed",
      contract.platforms["linux-installed"].requiredProviderRoutes,
      contract.platforms["linux-installed"].requiredLiveProviderRoutes,
      JSON.parse(readFileSync(candidateAttestationPath, "utf8")),
    ),
    health: {
      startup: "pass",
      shutdown: "pass",
      brokenLinks: 0,
      unexpectedConsoleErrors: 0,
      observed: "startup, link, console, and shutdown checks passed",
      evidence: healthEvidenceIdentity,
    },
  };
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
  const receipt = composeFinalSurfaceReceipt({
    receiptsDir: temp,
    driverRunDir: outputDir,
    scenarioReportPath: scenarioPath,
    signatureReceiptPath,
    candidateAttestationPath,
    candidateTeardownPath,
    installationReceiptPath,
    contract,
    inventory,
    driverPlan: plan,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    rootDir: root,
  });
  assert.equal(receipt.outcomes.length, 1);
  assert.equal(receipt.outcomes[0]?.expectedEffect, plan.assignments[0]?.expectedEffect);
  assert.equal(receipt.outcomes[0]?.oracleId, "fixture:isolated-result");
  assert.equal(receipt.outcomes[0]?.cleanupEvidence, "candidate-teardown");
  assert(receipt.evidenceArtifacts.some((row) => row.id === "driver-report-fixture-installed"));
  assert(receipt.evidenceArtifacts.some((row) => row.id === "scenario-report"));
  assert(receipt.evidenceArtifacts.some((row) => row.id === "scenario-health"));
  assert(receipt.evidenceArtifacts.some((row) => row.id.startsWith("provider-route-")));
  assert(receipt.evidenceArtifacts.some((row) => row.id === "candidate-attestation"));
  assert(receipt.evidenceArtifacts.some((row) => row.id === "candidate-teardown"));
  assert(receipt.evidenceArtifacts.some((row) => row.id === "driver-runtime-before-fixture-installed"));
  assert(receipt.evidenceArtifacts.some((row) => row.id === "driver-runtime-after-fixture-installed"));
  assert.equal(
    receipt.providerRoutes.length,
    contract.platforms["linux-installed"].requiredProviderRoutes.length,
  );

  const forgedHealth = structuredClone(fixtureHealthEvidence(fixtureCandidate));
  (forgedHealth.startup.response as { processId: number }).processId = 9999;
  const forgedStartupBytes = Buffer.from(JSON.stringify(forgedHealth.startup.response));
  forgedHealth.startup.responseSha256 = createHash("sha256").update(forgedStartupBytes).digest("hex");
  forgedHealth.startup.responseBytes = forgedStartupBytes.length;
  const forgedHealthPath = join(temp, "scenario-health-forged.json");
  const forgedHealthIdentity = writeJsonIdentity(forgedHealthPath, forgedHealth);
  const forgedHealthScenario = structuredClone(scenario);
  forgedHealthScenario.health.evidence = forgedHealthIdentity;
  const forgedHealthScenarioPath = join(temp, "linux-scenario-forged-health.json");
  writeFileSync(forgedHealthScenarioPath, `${JSON.stringify(forgedHealthScenario, null, 2)}\n`, "utf8");
  assert.throws(() => composeFinalSurfaceReceipt({
    receiptsDir: temp,
    driverRunDir: outputDir,
    scenarioReportPath: forgedHealthScenarioPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    contract,
    inventory,
    driverPlan: plan,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    rootDir: root,
  }), /startup response does not identify the exact candidate/, "scenario health cannot be backed by another process");

  const impossibleConsoleHealth = structuredClone(fixtureHealthEvidence(fixtureCandidate));
  impossibleConsoleHealth.console.startedAt = "1900-01-01T00:00:00.000Z";
  impossibleConsoleHealth.console.completedAt = "2200-01-01T00:00:00.000Z";
  impossibleConsoleHealth.console.subscription.openedAt = impossibleConsoleHealth.console.startedAt;
  impossibleConsoleHealth.console.subscription.closedAt = impossibleConsoleHealth.console.completedAt;
  const impossibleConsolePath = join(temp, "scenario-health-impossible-console.json");
  const impossibleConsoleIdentity = writeJsonIdentity(impossibleConsolePath, impossibleConsoleHealth);
  const impossibleConsoleScenario = structuredClone(scenario);
  impossibleConsoleScenario.health.evidence = impossibleConsoleIdentity;
  const impossibleConsoleScenarioPath = join(temp, "linux-scenario-impossible-console.json");
  writeFileSync(impossibleConsoleScenarioPath, `${JSON.stringify(impossibleConsoleScenario, null, 2)}\n`, "utf8");
  assert.throws(() => composeFinalSurfaceReceipt({
    receiptsDir: temp,
    driverRunDir: outputDir,
    scenarioReportPath: impossibleConsoleScenarioPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    contract,
    inventory,
    driverPlan: plan,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    rootDir: root,
  }), /console observation window must stay inside the collector interval/, "console coverage cannot exist outside the collector lifetime");

  const forgedShutdownDuration = structuredClone(fixtureHealthEvidence(fixtureCandidate));
  forgedShutdownDuration.shutdown.elapsedMs = 1;
  const forgedShutdownPath = join(temp, "scenario-health-forged-shutdown-duration.json");
  const forgedShutdownIdentity = writeJsonIdentity(forgedShutdownPath, forgedShutdownDuration);
  const forgedShutdownScenario = structuredClone(scenario);
  forgedShutdownScenario.health.evidence = forgedShutdownIdentity;
  const forgedShutdownScenarioPath = join(temp, "linux-scenario-forged-shutdown-duration.json");
  writeFileSync(forgedShutdownScenarioPath, `${JSON.stringify(forgedShutdownScenario, null, 2)}\n`, "utf8");
  assert.throws(() => composeFinalSurfaceReceipt({
    receiptsDir: temp,
    driverRunDir: outputDir,
    scenarioReportPath: forgedShutdownScenarioPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    contract,
    inventory,
    driverPlan: plan,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    rootDir: root,
  }), /shutdown elapsedMs must equal its observed timestamp interval/, "a claimed bounded shutdown must equal its timestamp interval");

  const requestPath = join(outputDir, "fixture-installed.request.json");
  const reportPath = join(outputDir, "fixture-installed.report.json");
  const beforeProbePath = join(outputDir, "fixture-installed.runtime-before.json");
  const afterProbePath = join(outputDir, "fixture-installed.runtime-after.json");
  const runManifestPath = join(outputDir, "run-manifest.json");
  const originals = [requestPath, reportPath, beforeProbePath, afterProbePath, runManifestPath]
    .map((path) => [path, readFileSync(path, "utf8")] as const);
  const driftInstanceId = "rewritten-instance-01";
  const driftRequest = JSON.parse(readFileSync(requestPath, "utf8")) as { runtime: { instanceId: string } };
  const driftReport = JSON.parse(readFileSync(reportPath, "utf8")) as { runtime: { instanceId: string } };
  const driftBefore = JSON.parse(readFileSync(beforeProbePath, "utf8")) as {
    runtime: { instanceId: string };
    health: { instanceId: string };
  };
  const driftAfter = JSON.parse(readFileSync(afterProbePath, "utf8")) as typeof driftBefore;
  for (const value of [driftRequest, driftReport, driftBefore, driftAfter]) value.runtime.instanceId = driftInstanceId;
  driftBefore.health.instanceId = driftInstanceId;
  driftAfter.health.instanceId = driftInstanceId;
  writeFileSync(requestPath, `${JSON.stringify(driftRequest, null, 2)}\n`, "utf8");
  const driftReportIdentity = writeJsonIdentity(reportPath, driftReport);
  const driftBeforeIdentity = writeJsonIdentity(beforeProbePath, driftBefore);
  const driftAfterIdentity = writeJsonIdentity(afterProbePath, driftAfter);
  const driftManifest = JSON.parse(readFileSync(runManifestPath, "utf8")) as {
    driverReports: Array<ReleaseSurfaceFileIdentity & {
      beforeProbe: ReleaseSurfaceFileIdentity;
      afterProbe: ReleaseSurfaceFileIdentity;
    }>;
  };
  Object.assign(driftManifest.driverReports[0]!, driftReportIdentity, {
    beforeProbe: driftBeforeIdentity,
    afterProbe: driftAfterIdentity,
  });
  writeFileSync(runManifestPath, `${JSON.stringify(driftManifest, null, 2)}\n`, "utf8");
  assert.throws(() => composeFinalSurfaceReceipt({
    receiptsDir: temp,
    driverRunDir: outputDir,
    scenarioReportPath: scenarioPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    contract,
    inventory,
    driverPlan: plan,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    rootDir: root,
  }), /request runtime does not match the exact candidate process/, "coordinated request/report/probe rewrites must not escape candidate binding");
  for (const [path, contents] of originals) writeFileSync(path, contents, "utf8");

  const failedSignaturePath = join(temp, "signature-failed.json");
  const failedSignature = JSON.parse(readFileSync(signatureReceiptPath, "utf8")) as {
    checks: Array<{ status: string }>;
  };
  failedSignature.checks[0]!.status = "fail";
  writeFileSync(failedSignaturePath, `${JSON.stringify(failedSignature, null, 2)}\n`, "utf8");
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath: failedSignaturePath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir: join(temp, "failed-signature-run"),
  }), /signature check .* must pass/, "the final runner must parse and reject failed native signature evidence");

  const tamperedCandidatePath = join(temp, "candidate-attestation-tampered.json");
  const tamperedCandidate = JSON.parse(readFileSync(candidateAttestationPath, "utf8")) as {
    distributionArtifact: { sha256: string };
  };
  tamperedCandidate.distributionArtifact.sha256 = "0".repeat(64);
  writeFileSync(tamperedCandidatePath, `${JSON.stringify(tamperedCandidate, null, 2)}\n`, "utf8");
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath: tamperedCandidatePath,
    installationReceiptPath,
    outputDir: join(temp, "tampered-candidate-run"),
  }), /distribution artifact identity does not match/, "a candidate attestation for different artifact bytes must be rejected");

  const forgedInstallationPath = join(temp, "installation-forged.json");
  const forgedInstallationIdentity = writeJsonIdentity(forgedInstallationPath, { status: "pass" });
  const forgedCandidatePath = join(temp, "candidate-attestation-forged-installation.json");
  writeFileSync(forgedCandidatePath, `${JSON.stringify(candidateAttestation(
    "linux-installed",
    artifactSha256,
    installedPayloadPath,
    forgedInstallationIdentity,
    parsedInstallationReceipt.payloadManifest.manifestSha256,
    runtimeBase,
    runtimeTokenPath,
    runtimeState.processId,
    artifactBytes,
    posixNativeRuntime,
  ), null, 2)}\n`, "utf8");
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath: forgedCandidatePath,
    installationReceiptPath: forgedInstallationPath,
    outputDir: join(temp, "forged-installation-run"),
  }), /installation receipt is invalid/, "an arbitrary pass object must not satisfy the runner's installation evidence contract");

  const unstructuredInstallation = structuredClone(parsedInstallationReceipt) as unknown as ReleaseSurfaceInstallationReceipt;
  delete unstructuredInstallation.nativeLinuxDebObservation;
  const unstructuredInstallationPath = join(temp, "installation-missing-linux-observation.json");
  const unstructuredInstallationIdentity = writeJsonIdentity(unstructuredInstallationPath, unstructuredInstallation);
  const unstructuredCandidatePath = join(temp, "candidate-attestation-missing-linux-observation.json");
  writeFileSync(unstructuredCandidatePath, `${JSON.stringify(candidateAttestation(
    "linux-installed",
    artifactSha256,
    installedPayloadPath,
    unstructuredInstallationIdentity,
    parsedInstallationReceipt.payloadManifest.manifestSha256,
    runtimeBase,
    runtimeTokenPath,
    runtimeState.processId,
    artifactBytes,
    posixNativeRuntime,
  ), null, 2)}\n`, "utf8");
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath: unstructuredCandidatePath,
    installationReceiptPath: unstructuredInstallationPath,
    outputDir: join(temp, "missing-linux-observation-run"),
  }), /structured native Debian observation/, "the runner must reject legacy Linux installer claims without structured package evidence");

  const wrongRuntimeCandidatePath = join(temp, "candidate-attestation-wrong-runtime.json");
  const wrongRuntimeCandidate = JSON.parse(readFileSync(candidateAttestationPath, "utf8")) as {
    runtime: { instanceId: string };
  };
  wrongRuntimeCandidate.runtime.instanceId = "wrong-instance-0001";
  writeFileSync(wrongRuntimeCandidatePath, `${JSON.stringify(wrongRuntimeCandidate, null, 2)}\n`, "utf8");
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath: wrongRuntimeCandidatePath,
    installationReceiptPath,
    outputDir: join(temp, "wrong-runtime-run"),
  }), /before-driver runtime probe failed.*instanceId/s, "the runner must centrally reject a runtime that does not match the live candidate");

  const assertInvalidScenario = (
    name: string,
    mutate: (value: ReleaseSurfaceScenarioReport) => void,
    pattern: RegExp,
  ) => {
    const invalidScenarioPath = join(temp, `linux-scenario-${name}.json`);
    const invalidScenario = structuredClone(scenario);
    mutate(invalidScenario);
    writeFileSync(invalidScenarioPath, `${JSON.stringify(invalidScenario, null, 2)}\n`, "utf8");
    assert.throws(() => composeFinalSurfaceReceipt({
      receiptsDir: temp,
      driverRunDir: outputDir,
      scenarioReportPath: invalidScenarioPath,
      signatureReceiptPath,
      candidateAttestationPath,
      installationReceiptPath,
      contract,
      inventory,
      driverPlan: plan,
      platform: "linux-installed",
      sourceCommit: sourceCommit,
      version: releaseSurfaceFixtureVersion,
      rootDir: root,
    }), pattern);
  };
  assertInvalidScenario("failed-route", (value) => {
    value.providerRoutes[0]!.status = "fail";
  }, /provider route .* must pass/);
  assertInvalidScenario("missing-route", (value) => {
    value.providerRoutes.pop();
  }, /required provider route .* is missing/);
  assertInvalidScenario("implicit-wsl", (value) => {
    const route = value.providerRoutes.find((row) => row.transportId === "ssh-windows-wsl")!;
    route.target.runtimeKind = "posix-native";
    delete route.target.wslDistro;
  }, /explicitly selected Linux WSL distro/);
  assertInvalidScenario("binary-drift", (value) => {
    value.providerRoutes[0]!.provider.executableSha256 = "not-a-digest";
  }, /executableSha256 must be 64 hex characters/);
  assertInvalidScenario("event-gap", (value) => {
    value.providerRoutes[0]!.stream.gapCount = 1;
  }, /zero sequence gaps/);
  assertInvalidScenario("wrong-native-protocol", (value) => {
    value.providerRoutes[0]!.stream.nativeProtocol = "plain-text";
  }, /provider-native protocol is invalid/);
  assertInvalidScenario("missing-completion-event", (value) => {
    value.providerRoutes.find((route) => route.evidenceMode === "live-canary")!
      .stream.observedEventKinds = ["started", "text"];
  }, /must contain only started, text, and completed/);
  assertInvalidScenario("identity-route-claims-canary", (value) => {
    const route = value.providerRoutes.find((candidateRoute) => candidateRoute.evidenceMode === "identity-only")!;
    route.stream.canaryId = RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID;
    route.stream.eventCount = 3;
    route.stream.observedEventKinds = ["started", "text", "completed"];
    route.stream.finalState = "completed";
    route.stream.canaryMatched = true;
  }, /identity-only evidence must not claim a live provider stream/);

  const forgedRouteScenarioPath = join(temp, "linux-scenario-forged-raw-canary.json");
  const forgedRouteScenario = structuredClone(scenario);
  const forgedScenarioRoute = forgedRouteScenario.providerRoutes.find(
    (route) => route.evidenceMode === "live-canary",
  )!;
  const originalRouteEvidencePath = join(temp, forgedScenarioRoute.evidence.basename);
  const forgedRouteEvidence = JSON.parse(readFileSync(originalRouteEvidencePath, "utf8")) as ReleaseSurfaceProviderRouteEvidence;
  const forgedCanaryEvent = forgedRouteEvidence.normalizedEvents.find((event) => event.canaryMatched)!;
  const forgedSourceFrame = forgedRouteEvidence.rawFrames.find(
    (frame) => frame.payloadSha256 === forgedCanaryEvent.sourceFrameSha256,
  )!;
  forgedSourceFrame.payload = { kind: "text", text: "NOT_THE_RELEASE_CANARY" };
  const forgedSourceBytes = Buffer.from(JSON.stringify(forgedSourceFrame.payload));
  forgedSourceFrame.payloadBytes = forgedSourceBytes.length;
  forgedSourceFrame.payloadSha256 = createHash("sha256").update(forgedSourceBytes).digest("hex");
  forgedCanaryEvent.sourceFrameSha256 = forgedSourceFrame.payloadSha256;
  const forgedRouteEvidencePath = join(temp, "provider-route-forged-raw-canary.json");
  forgedScenarioRoute.evidence = writeJsonIdentity(forgedRouteEvidencePath, forgedRouteEvidence);
  writeFileSync(forgedRouteScenarioPath, `${JSON.stringify(forgedRouteScenario, null, 2)}\n`, "utf8");
  assert.throws(() => composeFinalSurfaceReceipt({
    receiptsDir: temp,
    driverRunDir: outputDir,
    scenarioReportPath: forgedRouteScenarioPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    contract,
    inventory,
    driverPlan: plan,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    rootDir: root,
  }), /canary match is not derived from the exact bounded raw text/, "rehashed summaries cannot forge the raw provider canary");

  assert.throws(() => composeFinalSurfaceReceipt({
    receiptsDir: temp,
    driverRunDir: outputDir,
    scenarioReportPath: scenarioPath,
    signatureReceiptPath,
    candidateAttestationPath: "",
    installationReceiptPath,
    contract,
    inventory,
    driverPlan: plan,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    rootDir: root,
  }), /candidate attestation/, "receipt composition must require exact candidate-attestation evidence");

  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir,
  }), /output already exists/, "final evidence must be create-only");

  const partialPlan = structuredClone(plan);
  partialPlan.releaseReady = false;
  partialPlan.assignments = [];
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan: partialPlan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir: join(temp, "partial"),
  }), /plan is invalid|plan is building/, "final runner must refuse incomplete surface coverage");

  process.env.SHELLX_RELEASE_FIXTURE_MUTATE_INSTALLED_PATH = mutationProbePath;
  try {
    assert.throws(() => runReleaseSurfaceDrivers({
      rootDir: root,
      plan,
      inventory,
      contract,
      platform: "linux-installed",
      sourceCommit: sourceCommit,
      version: releaseSurfaceFixtureVersion,
      artifactPath,
      signatureReceiptPath,
      candidateAttestationPath,
      installationReceiptPath,
      outputDir: join(temp, "during-driver-mutation-run"),
    }), /installed payload manifest changed during the driver run/, "post-driver collection must reject driver-time installed payload mutation");
  } finally {
    delete process.env.SHELLX_RELEASE_FIXTURE_MUTATE_INSTALLED_PATH;
    writeFileSync(mutationProbePath, "stable installed fixture data", "utf8");
  }

  writeFileSync(mutationProbePath, "mutated installed fixture", "utf8");
  assert.throws(() => runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "linux-installed",
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir: join(temp, "mutated-install-run"),
  }), /installed payload manifest changed before the driver run/, "the runner must reject post-attestation installed payload mutation");
} finally {
  if (runtimeServer && runtimeServer.exitCode === null) {
    runtimeServer.kill("SIGTERM");
    await new Promise<void>((resolveExit) => runtimeServer!.once("exit", () => resolveExit()));
  }
  rmSync(temp, { recursive: true });
}

console.log("Release surface driver runner tests passed");

function candidateAttestation(
  platform: "windows-installed" | "linux-installed",
  artifactSha256: string,
  installedPayloadPath: string,
  receipt: ReleaseSurfaceFileIdentity,
  payloadManifestSha256: string,
  debugBase: string,
  debugTokenPath: string,
  processId: number,
  artifactBytes: number,
  posixNativeRuntime: ReleaseSurfacePosixNativeRuntime,
) {
  return {
    schema: RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
    mode: "final-frozen-candidate",
    platform,
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    createdAt: fixtureTimestamp("2026-07-28T17:59:30.000Z"),
    distributionArtifact: { basename: `shellx_${releaseSurfaceFixtureVersion}_amd64.deb`, sha256: artifactSha256, bytes: artifactBytes },
    installation: {
      method: "installer-observed",
      sourceArtifactSha256: artifactSha256,
      receipt,
      payloadManifestSha256,
    },
    installedPayload: {
      basename: "shellx",
      sha256: artifactSha256,
      bytes: artifactBytes,
      path: installedPayloadPath,
    },
    process: {
      pid: processId,
      executablePath: installedPayloadPath,
      executableSha256: artifactSha256,
    },
    runtime: {
      debugBase,
      debugPort: Number(new URL(debugBase).port),
      debugTokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpPort: 9,
      mcpTokenPath: debugTokenPath,
      processId,
      instanceId: "fixture-instance-0001",
      appVersion: releaseSurfaceFixtureVersion,
      buildCommit: sourceCommit,
    },
    posixNativeRuntime,
  } as const;
}

async function waitForRuntimeState(statePath: string, child: ChildProcess): Promise<{ port: number; processId: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { port?: number; processId?: number };
      if (Number.isSafeInteger(parsed.port) && Number(parsed.port) > 0
        && Number.isSafeInteger(parsed.processId) && Number(parsed.processId) > 0) {
        return { port: Number(parsed.port), processId: Number(parsed.processId) };
      }
    }
    if (child.exitCode !== null) throw new Error(`runtime fixture exited early with ${child.exitCode}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("runtime fixture did not publish its port");
}

function installationReceipt(
  platform: "windows-installed" | "linux-installed",
  artifactSha256: string,
  installedPayloadPath: string,
  installRoot: string,
  artifactBytes: number,
  artifactPath: string,
  signatureReceipt: ReleaseSurfaceFileIdentity,
) {
  const firstManifest = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: installRoot,
    recordedRootPath: installRoot,
    platform,
    scope: "installer-target-root",
    mainExecutableRelativePath: "usr/bin/shellx",
    collectedAt: fixtureTimestamp("2026-07-28T17:58:51.000Z"),
  });
  const secondManifest = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: installRoot,
    recordedRootPath: installRoot,
    platform,
    scope: "installer-target-root",
    mainExecutableRelativePath: "usr/bin/shellx",
    collectedAt: fixtureTimestamp("2026-07-28T17:58:52.000Z"),
  });
  return {
    schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
    platform,
    sourceCommit: sourceCommit,
    version: releaseSurfaceFixtureVersion,
    createdAt: fixtureTimestamp("2026-07-28T17:59:00.000Z"),
    method: "installer-observed",
    status: "pass",
    distributionArtifact: { basename: basename(artifactPath), sha256: artifactSha256, bytes: artifactBytes },
    installedPayload: {
      basename: "shellx",
      sha256: artifactSha256,
      bytes: artifactBytes,
      path: installedPayloadPath,
    },
    coverage: { payload: "complete-target-root", systemEffects: "declared-subset" },
    systemEffects: linuxFixtureSystemEffects(),
    nativeLinuxDebObservation: {
      schema: "shellx/release-surface-linux-deb-installation@1",
      collector: "linux-dpkg-deb-owned-root-v1",
      environment: "native-linux",
      observedAt: fixtureTimestamp("2026-07-28T17:58:50.500Z"),
      kernelRelease: "fixture-native-linux",
      architecture: process.arch,
      userId: 1000,
      userIsRoot: false,
      artifact: {
        basename: basename(artifactPath),
        sha256: artifactSha256,
        bytes: artifactBytes,
        path: artifactPath,
        pathSha256: releaseSurfaceLinuxPathDigest(artifactPath),
      },
      package: {
        format: "deb",
        name: RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME,
        version: releaseSurfaceFixtureVersion,
        architecture: process.arch === "arm64" ? "arm64" : "amd64",
        installedSizeKiB: 1,
        mainExecutableRelativePath: "usr/bin/shellx",
        controlScriptsPresent: [],
      },
      operation: {
        startedAt: fixtureTimestamp("2026-07-28T17:58:30.000Z"),
        completedAt: fixtureTimestamp("2026-07-28T17:58:50.000Z"),
        exitCode: 0,
        targetRootStateBefore: "absent",
        mode: "data-payload-extraction",
        tool: "dpkg-deb",
        toolVersion: "Debian dpkg-deb fixture",
        arguments: ["--extract", "<exact-deb-artifact>", "<redacted-run-owned-target>"],
        maintainerScriptsExecuted: false,
        systemPackageDatabaseMutated: false,
      },
      targetRootSha256: releaseSurfaceLinuxPathDigest(installRoot),
      safety: {
        before: linuxFixtureHostState(),
        after: linuxFixtureHostState(),
        runRootEntriesAfter: ["<receipt-owned-target>"],
      },
      systemEffects: linuxFixtureSystemEffects(),
    },
    signatureReceipt,
    linuxDigestVerification: { kind: "artifact-digest", algorithm: "sha256", sha256: artifactSha256 },
    operation: {
      adapter: platform === "windows-installed" ? "windows-nsis-install-v1" : "linux-package-install-v1",
      orchestrator: "native",
      startedAt: fixtureTimestamp("2026-07-28T17:58:30.000Z"),
      completedAt: fixtureTimestamp("2026-07-28T17:58:50.000Z"),
      targetRootStateBefore: "absent",
      exitCode: 0,
    },
    payloadManifest: secondManifest,
    manifestVerification: {
      firstCollectedAt: firstManifest.collectedAt,
      secondCollectedAt: secondManifest.collectedAt,
      firstManifestSha256: firstManifest.manifestSha256,
      secondManifestSha256: secondManifest.manifestSha256,
    },
    checks: [
      "native-linux-baseline",
      "artifact-digest-valid",
      "artifact-unchanged",
      "target-absent",
      "package-metadata-valid",
      "package-extraction-exit-zero",
      "payload-created",
      "payload-hash-recomputed",
      "manifest-double-collected",
      "system-effects-observed",
      "package-database-unchanged",
      "process-autolaunch-absent",
      "host-integration-unchanged",
    ].map((id) => ({
      id,
      status: "pass",
      observed: `${id} passed in the isolated ${platform} fixture`,
    })),
  } as const;
}

function linuxFixtureHostState() {
  return { packageDatabaseSha256: "b".repeat(64), shellxProcessIds: [], integrationTargetsPresent: [] };
}

function linuxFixtureSystemEffects() {
  return [
    {
      id: "linux-package-database-unchanged",
      status: "pass" as const,
      observed: "The dpkg status database digest was unchanged by owned-root data extraction.",
      details: { backend: "dpkg-status", beforeSha256: "b".repeat(64), afterSha256: "b".repeat(64) },
    },
    {
      id: "linux-process-autolaunch-absent",
      status: "pass" as const,
      observed: "No ShellX process existed before or appeared after package extraction.",
      details: { beforeProcessIds: [], afterProcessIds: [] },
    },
    {
      id: "linux-host-integration-unchanged",
      status: "pass" as const,
      observed: "Known host desktop, autostart, and service targets remained absent.",
      details: {
        targetsChecked: [
          "user-autostart",
          "user-desktop-entry",
          "user-systemd-service",
          "system-autostart",
          "system-desktop-entry",
          "system-systemd-service",
        ],
        beforePresent: [],
        afterPresent: [],
      },
    },
    {
      id: "linux-maintainer-scripts-not-executed",
      status: "pass" as const,
      observed: "Control scripts were inventoried while dpkg-deb extracted only the package data payload.",
      details: { scriptsPresent: [], executionMode: "data-payload-extraction", executed: false },
    },
  ];
}

function fixtureProviderRoutes(
  evidenceDir: string,
  platform: ReleasePlatform,
  requiredRoutes: FinalSurfaceRequiredProviderRoute[],
  requiredLiveRoutes: FinalSurfaceRequiredProviderRoute[],
  candidate: ReturnType<typeof candidateAttestation>,
): ReleaseSurfaceProviderRoute[] {
  const liveIds = new Set(requiredLiveRoutes.map(({ providerId, transportId }) => (
    releaseSurfaceProviderRouteId(providerId, transportId)
  )));
  return requiredRoutes.map(({ providerId, transportId }) => {
    const evidenceMode = liveIds.has(releaseSurfaceProviderRouteId(providerId, transportId))
      ? "live-canary" as const : "identity-only" as const;
    const hostOs = transportId.startsWith("ssh-windows") || transportId === "local-wsl"
      ? "windows"
      : transportId === "local-native"
        ? platform === "windows-installed" ? "windows" : platform === "macos-installed" ? "macos" : "linux"
        : "linux";
    const runtimeKind = transportId.endsWith("-wsl") || transportId === "local-wsl"
      ? "wsl"
      : hostOs === "windows" ? "windows-native" : "posix-native";
    const runtimeOs = runtimeKind === "wsl" ? "linux" : hostOs;
    const shellKind = runtimeKind === "wsl"
      ? "wsl-bash"
      : runtimeKind === "windows-native" ? "powershell" : "posix-shell";
    const transport = transportId === "local-native" ? "local" : transportId === "local-wsl" ? "wsl" : "ssh";
    const executable = runtimeKind === "windows-native"
      ? `C:\\ShellXFixture\\${providerId}.exe`
      : `/opt/shellx-fixture/${providerId}`;
    const routeWithoutEvidence: Omit<ReleaseSurfaceProviderRoute, "evidence"> = {
      id: releaseSurfaceProviderRouteId(providerId, transportId),
      transportId,
      providerId,
      status: "pass",
      evidenceMode,
      appHostPlatform: platform,
      target: {
        transport,
        hostOs,
        runtimeKind,
        runtimeOs,
        shellKind,
        hostFingerprintSha256: "8".repeat(64),
        ...(runtimeKind === "wsl" ? { wslDistro: "ShellX-Fixture-Ubuntu" } : {}),
      },
      provider: {
        executable,
        executableSha256: createHash("sha256").update(`${providerId}:${transportId}`).digest("hex"),
        executableBytes: 4096,
        version: `${providerId} fixture-1`,
      },
      stream: {
        canaryId: evidenceMode === "live-canary" ? RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID : null,
        nativeProtocol: providerId === "grok"
          ? "acp"
          : providerId === "codex-cli"
            ? "codex-jsonl"
            : providerId === "claude-code" ? "claude-stream-json" : "antigravity-stream-json",
        nativeStreamKind: providerId === "codex-cli" || providerId === "grok" ? "jsonl" : "stream-json",
        normalizedSchema: RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
        eventCount: evidenceMode === "live-canary" ? 3 : 0,
        observedEventKinds: evidenceMode === "live-canary" ? ["started", "text", "completed"] : [],
        finalState: evidenceMode === "live-canary" ? "completed" : "not-run",
        canaryMatched: evidenceMode === "live-canary",
        gapCount: 0,
        parseErrorCount: 0,
      },
      cleanup: "pass",
      startedAt: fixtureTimestamp("2026-07-28T18:00:02.100Z"),
      completedAt: fixtureTimestamp("2026-07-28T18:00:02.900Z"),
      observed: evidenceMode === "live-canary"
        ? `${providerId} completed its normalized canary on ${transportId}`
        : `${providerId} executable identity was observed on ${transportId}`,
    };
    const evidencePath = join(
      evidenceDir,
      `provider-route-${providerId}-${transportId}.json`,
    );
    const fixtureDeclaredRunId = `fixture-${providerId}-${transportId}`;
    const fixtureTabId = `release-route-${providerId}-${transportId}`;
    const rawFrames = evidenceMode === "live-canary" ? ["started", "text", "completed"].map((kind, index) => {
      const observedAtMs = fixtureTimestampMs("2026-07-28T18:00:02.200Z") + index * 100;
      const payload = providerId === "grok"
        ? index === 0
          ? { method: "session/update", params: { update: { sessionUpdate: "available_commands_update" } }, _meta: { tabId: fixtureTabId } }
          : index === 1
            ? { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SHELLX_PROVIDER_ROUTE_CANARY_V1" } } }, _meta: { tabId: fixtureTabId } }
            : { kind: "prompt_complete", stopReason: "end_turn", _meta: { tabId: fixtureTabId } }
        : {
            schemaVersion: 1,
            eventId: `fixture-event-${providerId}-${transportId}-${index + 1}`,
            kind,
            providerId,
            runId: fixtureDeclaredRunId,
            tabId: fixtureTabId,
            sequence: index + 1,
            occurredAtMs: observedAtMs,
            _meta: { tabId: fixtureTabId },
            ...(kind === "text" ? { text: "SHELLX_PROVIDER_ROUTE_CANARY_V1" } : {}),
            ...(kind === "completed" ? { exitCode: 0 } : {}),
          };
      const bytes = Buffer.from(JSON.stringify(payload));
      return {
        ordinal: index + 1,
        observedAtMs,
        channel: providerId === "grok"
          ? index === 2 ? "prompt-complete" : "grok-acp-event"
          : "provider-session-event",
        payloadSha256: createHash("sha256").update(bytes).digest("hex"),
        payloadBytes: bytes.length,
        payload,
      };
    }) : [];
    const normalizedEvents = deriveReleaseSurfaceProviderNormalizedEvents(
      rawFrames,
      providerId,
      routeWithoutEvidence.stream.nativeProtocol,
    );
    const runId = normalizedEvents[0]?.runId ?? "";
    const capabilitySnapshot: ReleaseSurfaceProviderRouteEvidence["capabilitySnapshot"] = {
      schemaVersion: "shellx.provider-capability-snapshot.v2",
      generatedAtMs: fixtureTimestampMs("2026-07-28T18:00:02.050Z"),
      freshUntilMs: fixtureTimestampMs("2026-07-28T18:01:02.050Z"),
      target: {
        key: `fixture:${transportId}`,
        transport,
        runtime: runtimeKind === "windows-native"
          ? "windows"
          : runtimeKind === "wsl" && transport === "ssh" ? "windows_wsl" : "posix",
        label: `Fixture ${transportId}`,
        ...(runtimeKind === "wsl" ? { wslDistro: "ShellX-Fixture-Ubuntu" } : {}),
      },
      providers: ["grok", "codex-cli", "claude-code", "antigravity-cli"].map((candidateProviderId) => candidateProviderId === providerId
        ? {
            providerId: candidateProviderId as "grok" | "codex-cli" | "claude-code" | "antigravity-cli",
            canRun: true,
            status: "ready" as const,
            binary: routeWithoutEvidence.provider.executable,
            version: routeWithoutEvidence.provider.version,
            binarySha256: routeWithoutEvidence.provider.executableSha256,
            binaryBytes: routeWithoutEvidence.provider.executableBytes,
            targetKey: `fixture:${transportId}`,
            checkedAtMs: fixtureTimestampMs("2026-07-28T18:00:02.040Z"),
          }
        : {
            providerId: candidateProviderId as "grok" | "codex-cli" | "claude-code" | "antigravity-cli",
            canRun: false,
            status: "missing" as const,
            targetKey: `fixture:${transportId}`,
            checkedAtMs: fixtureTimestampMs("2026-07-28T18:00:02.040Z"),
          }),
    };
    routeWithoutEvidence.target.hostFingerprintSha256 = createHash("sha256").update(JSON.stringify({
      target: capabilitySnapshot.target,
      providers: capabilitySnapshot.providers.map((row) => ({
        providerId: row.providerId,
        binarySha256: row.binarySha256,
        binaryBytes: row.binaryBytes,
      })).sort((a, b) => a.providerId.localeCompare(b.providerId)),
    })).digest("hex");
    const cleanupState = providerId === "grok"
      ? { count: 0, tabs: [] }
      : { activeRun: null, recentRuns: [{ runId, phase: "completed" }] };
    const cleanupStateBytes = Buffer.from(JSON.stringify(cleanupState));
    const evidence: ReleaseSurfaceProviderRouteEvidence = {
      schema: RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA,
      mode: "final-frozen-candidate",
      evidenceMode,
      collector: {
        id: RELEASE_SURFACE_PROVIDER_ROUTE_COLLECTOR_ID,
        sourceCommit: candidate.sourceCommit,
        startedAt: fixtureTimestamp("2026-07-28T18:00:02.000Z"),
        completedAt: fixtureTimestamp("2026-07-28T18:00:02.950Z"),
      },
      candidate: {
        platform: candidate.platform,
        sourceCommit: candidate.sourceCommit,
        version: candidate.version,
        artifactSha256: candidate.distributionArtifact.sha256,
        processId: candidate.runtime.processId,
        instanceId: candidate.runtime.instanceId,
        debugBase: candidate.runtime.debugBase,
      },
      healthBefore: {
        observedAt: fixtureTimestamp("2026-07-28T18:00:01.900Z"),
        processId: candidate.runtime.processId,
        instanceId: candidate.runtime.instanceId,
        appVersion: candidate.version,
        buildCommit: candidate.sourceCommit,
        debugPort: candidate.runtime.debugPort,
      },
      healthAfter: {
        observedAt: fixtureTimestamp("2026-07-28T18:00:03.000Z"),
        processId: candidate.runtime.processId,
        instanceId: candidate.runtime.instanceId,
        appVersion: candidate.version,
        buildCommit: candidate.sourceCommit,
        debugPort: candidate.runtime.debugPort,
      },
      eventStream: {
        transport: evidenceMode === "live-canary" ? "authenticated-websocket" : "not-opened",
        lagWarnings: 0,
      },
      capabilitySnapshot,
      route: routeWithoutEvidence,
      rawFrames,
      normalizedEvents,
      cleanup: evidenceMode === "live-canary" ? {
        requested: true,
        noActiveProviderRun: true,
        tabId: fixtureTabId,
        runId,
        terminalState: "completed",
        terminalEventSha256: rawFrames[2]!.payloadSha256,
        stateEndpoint: providerId === "grok" ? "/state/sessions" : "/provider-sessions/state",
        stateSha256: createHash("sha256").update(cleanupStateBytes).digest("hex"),
        stateBytes: cleanupStateBytes.length,
        state: cleanupState,
        observedAt: fixtureTimestamp("2026-07-28T18:00:02.890Z"),
        observed: "fixture provider process was inactive",
      } : {
        requested: false,
        noActiveProviderRun: true,
        terminalState: "not-started",
        observedAt: fixtureTimestamp("2026-07-28T18:00:02.890Z"),
        observed: "fixture provider process was not started",
      },
    };
    const identity = writeJsonIdentity(evidencePath, evidence);
    return { ...routeWithoutEvidence, evidence: identity };
  });
}

function writeJsonIdentity(path: string, value: unknown): ReleaseSurfaceFileIdentity {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, contents, "utf8");
  return {
    basename: path.split(/[\\/]/).at(-1) ?? path,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: Buffer.byteLength(contents),
  };
}

function readFileIdentity(path: string): ReleaseSurfaceFileIdentity {
  const contents = readFileSync(path);
  return {
    basename: path.split(/[\\/]/).at(-1) ?? path,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.length,
  };
}

function fixtureHealthEvidence(
  candidate: ReleaseSurfaceCandidateAttestation,
): ReleaseSurfaceHealthEvidence {
  const startupResponse = {
    processId: candidate.runtime.processId,
    instanceId: candidate.runtime.instanceId,
    appVersion: candidate.runtime.appVersion,
    buildCommit: candidate.runtime.buildCommit,
    debugApiPort: candidate.runtime.debugPort,
  };
  const startupBytes = Buffer.from(JSON.stringify(startupResponse));
  return {
    schema: RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA,
    mode: "final-frozen-candidate",
    collector: {
      id: RELEASE_SURFACE_HEALTH_COLLECTOR_ID,
      sourceCommit: candidate.sourceCommit,
      startedAt: fixtureTimestamp("2026-07-28T18:00:01.800Z"),
      completedAt: fixtureTimestamp("2026-07-28T18:00:03.100Z"),
    },
    candidate: {
      platform: candidate.platform,
      sourceCommit: candidate.sourceCommit,
      version: candidate.version,
      artifactSha256: candidate.distributionArtifact.sha256,
      processId: candidate.runtime.processId,
      instanceId: candidate.runtime.instanceId,
      debugBase: candidate.runtime.debugBase,
    },
    startup: {
      observedAt: fixtureTimestamp("2026-07-28T18:00:01.900Z"),
      responseSha256: createHash("sha256").update(startupBytes).digest("hex"),
      responseBytes: startupBytes.length,
      response: startupResponse,
    },
    links: {
      scope: "installed-driver-discovered-rendered-app-links",
      startedAt: fixtureTimestamp("2026-07-28T18:00:02.000Z"),
      completedAt: fixtureTimestamp("2026-07-28T18:00:02.900Z"),
      discovery: {
        collectorId: "installed-ui-rendered-link-discovery@1",
        startedAt: fixtureTimestamp("2026-07-28T18:00:02.000Z"),
        completedAt: fixtureTimestamp("2026-07-28T18:00:02.900Z"),
        discoveredCount: 1,
        identitySetSha256: createHash("sha256")
          .update(JSON.stringify([`tauri-command:fixture:${createHash("sha256").update("https://docs.theshellx.com").digest("hex")}`]))
          .digest("hex"),
        gapCount: 0,
      },
      checkedCount: 1,
      brokenLinks: 0,
      observations: [{
        sourceSurfaceId: "tauri-command:fixture",
        hrefSha256: createHash("sha256").update("https://docs.theshellx.com").digest("hex"),
        result: "ok",
        observedAt: fixtureTimestamp("2026-07-28T18:00:02.500Z"),
      }],
    },
    console: {
      scope: "installed-driver-console-subscription",
      startedAt: fixtureTimestamp("2026-07-28T18:00:01.990Z"),
      completedAt: fixtureTimestamp("2026-07-28T18:00:03.000Z"),
      subscription: {
        collectorId: "installed-webview-console-subscription@1",
        openedAt: fixtureTimestamp("2026-07-28T18:00:01.990Z"),
        closedAt: fixtureTimestamp("2026-07-28T18:00:03.000Z"),
        gapCount: 0,
      },
      observedEvents: 0,
      unexpectedConsoleErrors: 0,
      observations: [],
    },
    shutdown: {
      requestedAt: fixtureTimestamp("2026-07-28T18:00:02.950Z"),
      observedAt: fixtureTimestamp("2026-07-28T18:00:03.000Z"),
      processId: candidate.runtime.processId,
      mechanism: "fixture-window-close",
      processAbsent: true,
      elapsedMs: 50,
    },
  };
}

function fixtureHealthGit(args: string[]): string {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${root}\n`;
  if (args[0] === "rev-parse" && args[1] === "HEAD") return `${sourceCommit}\n`;
  if (args[0] === "status") return "";
  if (args[0] === "ls-files") {
    return "scripts/create-release-surface-health-evidence.ts\nscripts/lib/release-surface-health-evidence.ts\n";
  }
  throw new Error(`unexpected health evidence git probe ${args.join(" ")}`);
}
