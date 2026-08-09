import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ReleaseSurfaceCandidateAttestation,
  ReleaseSurfaceFileIdentity,
} from "./release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
} from "./release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
  type ReleaseSurfaceDriverRunManifest,
} from "./release-surface-driver-runner";
import {
  RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA,
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  type ReleaseSurfaceRunProfileCleanupReceipt,
} from "./release-surface-run-profile";
import {
  RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA,
  type ReleaseSurfaceWebDriverLifecycleReceipt,
} from "./release-surface-webdriver-lifecycle";
import {
  validateReleaseSurfaceMacosNativeInputBinding,
  type ReleaseSurfaceMacosNativeInputBindingEvidence,
} from "./release-surface-macos-native-input";

export const RELEASE_SURFACE_CANDIDATE_TEARDOWN_SCHEMA =
  "shellx/release-surface-candidate-teardown@2";

type CandidateTeardownPlatform = Extract<
  ReleaseSurfaceCandidateAttestation["platform"],
  "windows-installed" | "macos-installed" | "linux-installed"
>;

export interface ReleaseSurfaceCandidateTeardownReceipt {
  schema: typeof RELEASE_SURFACE_CANDIDATE_TEARDOWN_SCHEMA;
  mode: "final-frozen-candidate";
  status: "pass";
  platform: CandidateTeardownPlatform;
  sourceCommit: string;
  version: string;
  artifactSha256: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  candidateAttestation: ReleaseSurfaceFileIdentity;
  driverRunManifest: ReleaseSurfaceFileIdentity;
  candidate: {
    processId: number;
    instanceIdSha256: string;
    executableSha256: string;
    debugPort: number;
    mcpPort: number;
  };
  webdriverLifecycle?: ReleaseSurfaceFileIdentity & {
    sessionDeleted: "pass";
    driverStopped: "pass";
  };
  macosNativeInputBinding?: ReleaseSurfaceFileIdentity & {
    candidateBound: "pass";
  };
  profileCleanup: ReleaseSurfaceFileIdentity & {
    profilePathSha256: string;
    alreadyStopped: boolean;
    identityVerifiedBeforeStop: boolean;
    forcedStop: boolean;
    processCountAfter: 0;
    ownedDriverCountAfter: 0;
    debugListenerCountAfter: 0;
    mcpListenerCountAfter: 0;
    markerVerified: true;
    profileRemoved: true;
  };
}

export interface ReleaseSurfaceCandidateTeardownInput {
  platform: CandidateTeardownPlatform;
  runId: string;
  candidateAttestation: ReleaseSurfaceCandidateAttestation;
  candidateAttestationIdentity: ReleaseSurfaceFileIdentity;
  driverRunManifest: ReleaseSurfaceDriverRunManifest;
  driverRunManifestIdentity: ReleaseSurfaceFileIdentity;
  webdriverLifecycle?: ReleaseSurfaceWebDriverLifecycleReceipt;
  webdriverLifecycleIdentity?: ReleaseSurfaceFileIdentity;
  macosNativeInputBinding?: ReleaseSurfaceMacosNativeInputBindingEvidence;
  macosNativeInputBindingIdentity?: ReleaseSurfaceFileIdentity;
  profileCleanup: ReleaseSurfaceRunProfileCleanupReceipt;
  profileCleanupIdentity: ReleaseSurfaceFileIdentity;
}

export function createReleaseSurfaceCandidateTeardownReceipt(
  input: ReleaseSurfaceCandidateTeardownInput,
): ReleaseSurfaceCandidateTeardownReceipt {
  const errors = validateCandidateTeardownInputs(input);
  if (errors.length > 0) throw new Error(`candidate teardown evidence is invalid: ${errors.join("; ")}`);
  const candidate = input.candidateAttestation;
  const cleanup = input.profileCleanup;
  return {
    schema: RELEASE_SURFACE_CANDIDATE_TEARDOWN_SCHEMA,
    mode: "final-frozen-candidate",
    status: "pass",
    platform: input.platform,
    sourceCommit: candidate.sourceCommit,
    version: candidate.version,
    artifactSha256: candidate.distributionArtifact.sha256,
    runId: input.runId,
    startedAt: cleanup.startedAt,
    completedAt: cleanup.completedAt,
    candidateAttestation: exactIdentity(input.candidateAttestationIdentity),
    driverRunManifest: exactIdentity(input.driverRunManifestIdentity),
    candidate: {
      processId: candidate.process.pid,
      instanceIdSha256: sha256(candidate.runtime.instanceId),
      executableSha256: candidate.process.executableSha256,
      debugPort: candidate.runtime.debugPort,
      mcpPort: candidate.runtime.mcpPort,
    },
    ...(input.platform === "macos-installed"
      ? {
          macosNativeInputBinding: {
            ...exactIdentity(input.macosNativeInputBindingIdentity!),
            candidateBound: "pass" as const,
          },
        }
      : {
          webdriverLifecycle: {
            ...exactIdentity(input.webdriverLifecycleIdentity!),
            sessionDeleted: "pass" as const,
            driverStopped: "pass" as const,
          },
        }),
    profileCleanup: {
      ...exactIdentity(input.profileCleanupIdentity),
      profilePathSha256: cleanup.profilePathSha256,
      alreadyStopped: cleanup.application.alreadyStopped,
      identityVerifiedBeforeStop: cleanup.application.identityVerifiedBeforeStop,
      forcedStop: cleanup.application.forcedStop,
      processCountAfter: 0,
      ownedDriverCountAfter: 0,
      debugListenerCountAfter: 0,
      mcpListenerCountAfter: 0,
      markerVerified: true,
      profileRemoved: true,
    },
  };
}

export function validateReleaseSurfaceCandidateTeardownReceipt(input: {
  receipt: ReleaseSurfaceCandidateTeardownReceipt;
  evidence: ReleaseSurfaceCandidateTeardownInput;
}): string[] {
  const errors = validateCandidateTeardownInputs(input.evidence);
  let expected: ReleaseSurfaceCandidateTeardownReceipt | null = null;
  if (errors.length === 0) {
    expected = createReleaseSurfaceCandidateTeardownReceipt(input.evidence);
  }
  if (input.receipt.schema !== RELEASE_SURFACE_CANDIDATE_TEARDOWN_SCHEMA) {
    errors.push(`candidate teardown schema must be ${RELEASE_SURFACE_CANDIDATE_TEARDOWN_SCHEMA}`);
  }
  if (input.receipt.mode !== "final-frozen-candidate") errors.push("candidate teardown mode must be final-frozen-candidate");
  if (input.receipt.status !== "pass") errors.push("candidate teardown status must be pass");
  if (expected && stableJson(input.receipt) !== stableJson(expected)) {
    errors.push("candidate teardown receipt does not exactly match recomposed post-exit evidence");
  }
  return errors;
}

export function loadReleaseSurfaceCandidateTeardownReceipt(
  path: string,
): ReleaseSurfaceCandidateTeardownReceipt {
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceCandidateTeardownReceipt;
}

function validateCandidateTeardownInputs(input: ReleaseSurfaceCandidateTeardownInput): string[] {
  const errors: string[] = [];
  const candidate = input.candidateAttestation;
  const manifest = input.driverRunManifest;
  const lifecycle = input.webdriverLifecycle;
  const cleanup = input.profileCleanup;
  if (!["windows-installed", "macos-installed", "linux-installed"].includes(input.platform)) {
    errors.push("candidate teardown platform is unsupported");
  }
  if (!/^[a-f0-9]{16,64}$/.test(input.runId)) errors.push("candidate teardown runId is invalid");
  if (candidate.schema !== RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA
    || candidate.mode !== "final-frozen-candidate") {
    errors.push("candidate teardown requires the exact frozen candidate attestation schema");
  }
  if (candidate.platform !== input.platform) errors.push("candidate teardown platform does not match candidate attestation");
  if (manifest.schema !== RELEASE_SURFACE_DRIVER_RUN_SCHEMA || manifest.mode !== "final-frozen-candidate") {
    errors.push("candidate teardown requires the exact driver run manifest schema");
  }
  if (manifest.platform !== input.platform
    || manifest.sourceCommit !== candidate.sourceCommit
    || manifest.version !== candidate.version) {
    errors.push("driver run identity does not match the candidate attestation");
  }
  compareIdentity(errors, "driver run candidate attestation", manifest.candidateAttestation, input.candidateAttestationIdentity);
  if (manifest.artifact.sha256 !== candidate.distributionArtifact.sha256) {
    errors.push("driver run artifact does not match the candidate artifact");
  }
  if (manifest.candidateVerification.processId !== candidate.process.pid
    || manifest.candidateVerification.instanceId !== candidate.runtime.instanceId
    || manifest.candidateVerification.debugBase !== candidate.runtime.debugBase
    || manifest.candidateVerification.mcpBase !== candidate.runtime.mcpBase
    || manifest.candidateVerification.buildCommit !== candidate.sourceCommit) {
    errors.push("driver run candidate verification does not match the attested runtime");
  }
  if (input.platform === "macos-installed") {
    if (lifecycle || input.webdriverLifecycleIdentity) {
      errors.push("macOS candidate teardown must not claim an unsupported WebDriver lifecycle");
    }
    const binding = input.macosNativeInputBinding;
    const bindingIdentity = input.macosNativeInputBindingIdentity;
    if (!binding || !bindingIdentity) {
      errors.push("macOS candidate teardown requires the exact native-input binding evidence");
    } else {
      const bindingErrors = validateReleaseSurfaceMacosNativeInputBinding({
        evidence: binding,
        candidate,
        helperIdentity: binding.helper,
      });
      errors.push(...bindingErrors.map((error) => `macOS native-input binding: ${error}`));
      compareIdentity(errors, "macOS native-input binding", manifest.macosNativeInputBinding!, bindingIdentity);
      validateIdentity(errors, "macOS native-input binding evidence", bindingIdentity);
    }
    if (manifest.nativeWebDriverBinding || !manifest.macosNativeInputBinding) {
      errors.push("macOS candidate teardown requires native-input-only driver binding evidence");
    }
  } else {
    if (input.macosNativeInputBinding || input.macosNativeInputBindingIdentity) {
      errors.push("Windows/Linux candidate teardown must not claim macOS native-input evidence");
    }
    if (!lifecycle || !input.webdriverLifecycleIdentity
      || lifecycle.schema !== RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA
      || lifecycle.mode !== "final-frozen-candidate"
      || lifecycle.status !== "pass"
      || lifecycle.cleanup.sessionDeleted !== "pass"
      || lifecycle.cleanup.driverStopped !== "pass") {
      errors.push("candidate teardown requires a passing WebDriver lifecycle and cleanup");
    } else if (lifecycle.application.sha256 !== candidate.installedPayload.sha256) {
      errors.push("WebDriver lifecycle application does not match the installed candidate");
    }
  }
  if (cleanup.schema !== RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA
    || cleanup.mode !== "final-frozen-candidate"
    || cleanup.status !== "pass"
    || cleanup.platform !== input.platform
    || cleanup.runId !== input.runId) {
    errors.push("candidate teardown requires a passing matching run-profile cleanup");
  }
  if (cleanup.application.processId !== candidate.process.pid
    || cleanup.application.processCountAfter !== 0) {
    errors.push("candidate process absence does not match the attested PID");
  }
  if (!cleanup.application.alreadyStopped && !cleanup.application.identityVerifiedBeforeStop) {
    errors.push("a running candidate must be identity-verified before it is stopped");
  }
  if (cleanup.nativeDriver.processCountAfter !== 0) errors.push("owned native driver processes remain after teardown");
  if (cleanup.listeners.debugCountAfter !== 0 || cleanup.listeners.mcpCountAfter !== 0) {
    errors.push("candidate loopback listeners remain after teardown");
  }
  if (!cleanup.profile.markerVerified || !cleanup.profile.removed) {
    errors.push("candidate disposable profile was not marker-verified and removed");
  }
  let expectedProfileDigest = "";
  try {
    expectedProfileDigest = sha256(releaseSurfaceProfileLaunchRootFromDebugTokenPath(
      candidate.runtime.debugTokenPath,
      input.platform,
    ));
  } catch (error) {
    errors.push(`candidate profile path could not be derived: ${errorMessage(error)}`);
  }
  if (expectedProfileDigest && cleanup.profilePathSha256 !== expectedProfileDigest) {
    errors.push("run-profile cleanup does not match the candidate token profile");
  }
  const manifestCompletedAt = Date.parse(manifest.completedAt);
  const lifecycleCompletedAt = input.platform === "macos-installed"
    ? Date.parse(manifest.completedAt)
    : Date.parse(lifecycle?.completedAt ?? "");
  const cleanupStartedAt = Date.parse(cleanup.startedAt);
  const cleanupCompletedAt = Date.parse(cleanup.completedAt);
  if (![manifestCompletedAt, lifecycleCompletedAt, cleanupStartedAt, cleanupCompletedAt].every(Number.isFinite)) {
    errors.push("candidate teardown timestamps must be valid ISO times");
  } else {
    if (manifestCompletedAt > cleanupStartedAt) errors.push("candidate teardown began before the driver run manifest completed");
    if (lifecycleCompletedAt > cleanupStartedAt) errors.push("candidate teardown began before the WebDriver lifecycle completed");
    if (cleanupCompletedAt < cleanupStartedAt) errors.push("candidate teardown completed before it started");
  }
  for (const [label, identity] of [
    ["candidate attestation", input.candidateAttestationIdentity],
    ["driver run manifest", input.driverRunManifestIdentity],
    ...(input.platform === "macos-installed"
      ? [["macOS native-input binding", input.macosNativeInputBindingIdentity!]] as const
      : [["WebDriver lifecycle", input.webdriverLifecycleIdentity!]] as const),
    ["run-profile cleanup", input.profileCleanupIdentity],
  ] as const) validateIdentity(errors, label, identity);
  return errors;
}

function validateIdentity(errors: string[], label: string, value: ReleaseSurfaceFileIdentity): void {
  if (!value?.basename?.trim()
    || !/^[a-f0-9]{64}$/.test(value.sha256 ?? "")
    || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0) {
    errors.push(`${label} file identity is invalid`);
  }
}

function exactIdentity(value: ReleaseSurfaceFileIdentity): ReleaseSurfaceFileIdentity {
  return { basename: value.basename, sha256: value.sha256, bytes: value.bytes };
}

function compareIdentity(
  errors: string[],
  label: string,
  actual: ReleaseSurfaceFileIdentity,
  expected: ReleaseSurfaceFileIdentity,
): void {
  validateIdentity(errors, label, actual);
  if (actual?.basename !== expected.basename || actual?.sha256 !== expected.sha256 || actual?.bytes !== expected.bytes) {
    errors.push(`${label} file identity does not match`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
