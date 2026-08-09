import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createReleaseSurfaceCandidateTeardownReceipt,
  validateReleaseSurfaceCandidateTeardownReceipt,
  type ReleaseSurfaceCandidateTeardownInput,
} from "./lib/release-surface-candidate-teardown";
import {
  RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
  type ReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./lib/release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
  type ReleaseSurfaceDriverRunManifest,
} from "./lib/release-surface-driver-runner";
import {
  RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA,
  type ReleaseSurfaceRunProfileCleanupReceipt,
} from "./lib/release-surface-run-profile";
import {
  RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA,
  type ReleaseSurfaceWebDriverLifecycleReceipt,
} from "./lib/release-surface-webdriver-lifecycle";
import {
  RELEASE_SURFACE_MACOS_NATIVE_INPUT_BINDING_SCHEMA,
  type ReleaseSurfaceMacosNativeInputBindingEvidence,
} from "./lib/release-surface-macos-native-input";
import { syntheticReleaseSurfaceControllerBinding } from "./fixtures/release-surface-controller-binding-fixture";

const sourceCommit = "a".repeat(40);
const profilePath = "/tmp/shellx-final-webdriver-0123456789abcdef";
const artifact = identity("shellx", "b", 1_024);
const candidateIdentity = identity("candidate-attestation.json", "c", 2_048);
const manifestIdentity = identity("run-manifest.json", "d", 4_096);
const lifecycleIdentity = identity("webdriver-lifecycle.json", "e", 1_024);
const cleanupIdentity = identity("profile-cleanup.json", "f", 1_024);
const candidate: ReleaseSurfaceCandidateAttestation = {
  schema: RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
  mode: "final-frozen-candidate",
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.5",
  createdAt: "2026-07-30T01:00:00.000Z",
  distributionArtifact: artifact,
  installation: {
    method: "direct-artifact",
    sourceArtifactSha256: artifact.sha256,
    receipt: identity("installation.json", "1", 512),
    payloadManifestSha256: "2".repeat(64),
  },
  installedPayload: { ...artifact, path: "/opt/shellx/shellx" },
  process: { pid: 4321, executablePath: "/opt/shellx/shellx", executableSha256: artifact.sha256 },
  runtime: {
    debugBase: "http://127.0.0.1:30123",
    debugPort: 30123,
    debugTokenPath: `${profilePath}/.shellx/shellxagent.token`,
    mcpBase: "http://127.0.0.1:30124",
    mcpPort: 30124,
    mcpTokenPath: `${profilePath}/.shellx/mcp.token`,
    processId: 4321,
    instanceId: "shellx-final-0123456789abcdef",
    appVersion: "0.3.5",
    buildCommit: sourceCommit,
  },
};
const manifest: ReleaseSurfaceDriverRunManifest = {
  schema: RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
  mode: "final-frozen-candidate",
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.5",
  inventoryDigest: "3".repeat(64),
  startedAt: "2026-07-30T01:00:01.000Z",
  completedAt: "2026-07-30T01:00:05.000Z",
  controller: syntheticReleaseSurfaceControllerBinding(sourceCommit),
  artifact,
  signatureReceipt: identity("signature.json", "4", 512),
  candidateAttestation: candidateIdentity,
  installationReceipt: candidate.installation.receipt,
  candidateVerification: {
    installedPayloadSha256: artifact.sha256,
    installedManifestSha256: candidate.installation.payloadManifestSha256,
    installedManifestBeforeCollectedAt: "2026-07-30T01:00:01.000Z",
    installedManifestAfterCollectedAt: "2026-07-30T01:00:05.000Z",
    processId: candidate.process.pid,
    instanceId: candidate.runtime.instanceId,
    debugBase: candidate.runtime.debugBase,
    debugTokenPath: candidate.runtime.debugTokenPath,
    mcpBase: candidate.runtime.mcpBase,
    mcpTokenPath: candidate.runtime.mcpTokenPath,
    buildCommit: sourceCommit,
  },
  signatureVerification: { status: "digest-verified", checks: ["fixture"] },
  driverReports: [],
};
const lifecycle: ReleaseSurfaceWebDriverLifecycleReceipt = {
  schema: RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA,
  mode: "final-frozen-candidate",
  status: "pass",
  startedAt: "2026-07-30T01:00:00.000Z",
  completedAt: "2026-07-30T01:00:06.000Z",
  driver: {
    ...identity("tauri-driver", "5", 512),
    launchPath: "/usr/bin/tauri-driver",
    argsPrefixSha256: "6".repeat(64),
    processId: 5000,
    base: "http://127.0.0.1:30125",
    nativePort: 30126,
  },
  application: { ...artifact, launchPath: candidate.installedPayload.path },
  driverLog: { retainedSha256: "7".repeat(64), retainedBytes: 0, observedBytes: 0, truncated: false },
  session: { created: true, sessionIdSha256: "8".repeat(64), workCompleted: true },
  cleanup: {
    sessionDeleted: "pass",
    driverStopped: "pass",
    sessionDelete: {
      requestedAt: "2026-07-30T01:00:05.000Z",
      completedAt: "2026-07-30T01:00:05.500Z",
    },
  },
};
const cleanup: ReleaseSurfaceRunProfileCleanupReceipt = {
  schema: RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA,
  mode: "final-frozen-candidate",
  status: "pass",
  platform: "linux-installed",
  runId: "0123456789abcdef",
  startedAt: "2026-07-30T01:00:07.000Z",
  completedAt: "2026-07-30T01:00:08.000Z",
  profilePathSha256: sha256(profilePath),
  application: {
    processId: candidate.process.pid,
    alreadyStopped: true,
    identityVerifiedBeforeStop: false,
    forcedStop: false,
    processCountAfter: 0,
  },
  nativeDriver: { configured: false, forcedStopCount: 0, processCountAfter: 0 },
  listeners: { debugCountAfter: 0, mcpCountAfter: 0 },
  profile: { markerVerified: true, removed: true },
};
const evidence: ReleaseSurfaceCandidateTeardownInput = {
  platform: "linux-installed",
  runId: cleanup.runId,
  candidateAttestation: candidate,
  candidateAttestationIdentity: candidateIdentity,
  driverRunManifest: manifest,
  driverRunManifestIdentity: manifestIdentity,
  webdriverLifecycle: lifecycle,
  webdriverLifecycleIdentity: lifecycleIdentity,
  profileCleanup: cleanup,
  profileCleanupIdentity: cleanupIdentity,
};

const receipt = createReleaseSurfaceCandidateTeardownReceipt(evidence);
assert.equal(receipt.status, "pass");
assert.equal(receipt.candidate.processId, candidate.process.pid);
assert.equal(receipt.profileCleanup.processCountAfter, 0);
assert.equal(receipt.profileCleanup.debugListenerCountAfter, 0);
assert.equal(receipt.profileCleanup.profileRemoved, true);
assert.equal(JSON.stringify(receipt).includes(profilePath), false);
assert.deepEqual(validateReleaseSurfaceCandidateTeardownReceipt({ receipt, evidence }), []);

const forged = structuredClone(receipt);
forged.candidate.processId = 9999;
assert(
  validateReleaseSurfaceCandidateTeardownReceipt({ receipt: forged, evidence })
    .some((error) => error.includes("exactly match recomposed")),
);

const listenerLeak = structuredClone(evidence);
listenerLeak.profileCleanup.listeners.debugCountAfter = 1;
assert.throws(
  () => createReleaseSurfaceCandidateTeardownReceipt(listenerLeak),
  /loopback listeners remain/,
);

const earlyCleanup = structuredClone(evidence);
earlyCleanup.profileCleanup.startedAt = "2026-07-30T01:00:04.000Z";
assert.throws(
  () => createReleaseSurfaceCandidateTeardownReceipt(earlyCleanup),
  /driver run manifest completed|WebDriver lifecycle completed/,
);

const unverifiedRunningCandidate = structuredClone(evidence);
unverifiedRunningCandidate.profileCleanup.application.alreadyStopped = false;
assert.throws(
  () => createReleaseSurfaceCandidateTeardownReceipt(unverifiedRunningCandidate),
  /identity-verified/,
);

const macProfilePath = "/Users/test/Library/Caches/shellx-final-webdriver-fedcba9876543210";
const macCandidate: ReleaseSurfaceCandidateAttestation = {
  ...structuredClone(candidate),
  platform: "macos-installed",
  installedPayload: { ...artifact, path: "/Applications/shellX.app/Contents/MacOS/shellx" },
  process: {
    pid: 8765,
    executablePath: "/Applications/shellX.app/Contents/MacOS/shellx",
    executableSha256: artifact.sha256,
  },
  runtime: {
    ...candidate.runtime,
    processId: 8765,
    instanceId: "shellx-final-fedcba9876543210",
    debugTokenPath: `${macProfilePath}/.shellx/shellxagent.token`,
    mcpTokenPath: `${macProfilePath}/.shellx/mcp.token`,
  },
};
const macBindingIdentity = identity("macos-native-input-binding.json", "9", 2_048);
const macBinding: ReleaseSurfaceMacosNativeInputBindingEvidence = {
  schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_BINDING_SCHEMA,
  mode: "final-frozen-candidate",
  platform: "macos-installed",
  sourceCommit,
  version: "0.3.5",
  createdAt: "2026-07-30T01:00:02.000Z",
  candidate: {
    processId: macCandidate.process.pid,
    instanceId: macCandidate.runtime.instanceId,
    executableSha256: artifact.sha256,
    installedPayloadSha256: artifact.sha256,
    distributionArtifactSha256: artifact.sha256,
    debugBase: macCandidate.runtime.debugBase,
  },
  helper: identity("shellx-release-macos-native-input", "a", 8_192),
  permissions: {
    accessibilityTrusted: true,
    eventPostingTrusted: true,
    promptRequested: false,
    operatorPrerequisite: "Accessibility",
  },
  window: {
    ownerProcessId: macCandidate.process.pid,
    number: 42,
    titleSha256: "b".repeat(64),
    boundsSha256: "c".repeat(64),
    webAreaBoundsSha256: "d".repeat(64),
    webAreaSource: "renderer-window-content",
  },
  challenge: {
    id: "final-macos-native-input-fixture",
    selectorSha256: "e".repeat(64),
    rectSha256: "f".repeat(64),
    candidateReportedResolved: true,
    helperMappedTarget: true,
    candidateReportedCleared: true,
    eventsPosted: 0,
  },
};
const macManifest: ReleaseSurfaceDriverRunManifest = {
  ...structuredClone(manifest),
  platform: "macos-installed",
  candidateAttestation: candidateIdentity,
  candidateVerification: {
    ...manifest.candidateVerification,
    processId: macCandidate.process.pid,
    instanceId: macCandidate.runtime.instanceId,
    debugTokenPath: macCandidate.runtime.debugTokenPath,
    mcpTokenPath: macCandidate.runtime.mcpTokenPath,
  },
  macosNativeInputBinding: macBindingIdentity,
};
const macCleanup: ReleaseSurfaceRunProfileCleanupReceipt = {
  ...structuredClone(cleanup),
  platform: "macos-installed",
  runId: "fedcba9876543210",
  profilePathSha256: sha256(macProfilePath),
  application: { ...cleanup.application, processId: macCandidate.process.pid },
};
const macEvidence: ReleaseSurfaceCandidateTeardownInput = {
  platform: "macos-installed",
  runId: macCleanup.runId,
  candidateAttestation: macCandidate,
  candidateAttestationIdentity: candidateIdentity,
  driverRunManifest: macManifest,
  driverRunManifestIdentity: manifestIdentity,
  macosNativeInputBinding: macBinding,
  macosNativeInputBindingIdentity: macBindingIdentity,
  profileCleanup: macCleanup,
  profileCleanupIdentity: cleanupIdentity,
};
const macReceipt = createReleaseSurfaceCandidateTeardownReceipt(macEvidence);
assert.equal(macReceipt.platform, "macos-installed");
assert.equal(macReceipt.webdriverLifecycle, undefined);
assert.equal(macReceipt.macosNativeInputBinding?.candidateBound, "pass");
assert.deepEqual(validateReleaseSurfaceCandidateTeardownReceipt({ receipt: macReceipt, evidence: macEvidence }), []);
assert.throws(
  () => createReleaseSurfaceCandidateTeardownReceipt({ ...macEvidence, macosNativeInputBinding: undefined }),
  /exact native-input binding evidence/,
);

console.log("Release surface candidate teardown tests passed");

function identity(basename: string, digit: string, bytes: number): ReleaseSurfaceFileIdentity {
  return { basename, sha256: digit.repeat(64), bytes };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
