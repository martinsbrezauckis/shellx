import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  describeReadyDriver,
  driverReadyOnPlatform,
  type FinalSurfaceDriverPlan,
} from "./release-surface-driver-plan";
import {
  releaseSurfaceDriverPhaseReportPassed,
  validateReleaseSurfaceDriverReport,
  validateReleaseSurfaceDriverRequest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./release-surface-driver-protocol";
import {
  validateReleaseSurfaceRuntimeProbe,
  type ReleaseSurfaceRuntimeProbe,
} from "./release-surface-runtime-candidate";
import {
  loadReleaseSurfaceCandidateAttestation,
  validateReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./release-surface-candidate-attestation";
import {
  loadReleaseSurfaceInstallationReceipt,
  validateReleaseSurfaceInstallationReceipt,
} from "./release-surface-installation-receipt";
import {
  loadReleaseSurfaceSignatureReceipt,
  validateReleaseSurfaceSignatureReceipt,
} from "./release-surface-signature-receipt";
import {
  validateReleaseSurfaceWebDriverBinding,
  type ReleaseSurfaceWebDriverBindingEvidence,
} from "./release-surface-webdriver-binding";
import { verifyReleaseSurfaceControllerBindingFromGit } from "./release-surface-controller-binding";
import type { ReleaseSurfaceWebDriverOrchestrationReceipt } from "./release-surface-webdriver-orchestration";
import type { ReleaseSurfaceWebDriverLifecycleReceipt } from "./release-surface-webdriver-lifecycle";
import type { ReleaseSurfaceRunProfileCleanupReceipt } from "./release-surface-run-profile";
import type { FinalSurfaceContract } from "./release-surface-receipts";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";
import type {
  ReleaseSurfaceOutcomeSlice,
  ReleaseSurfaceSliceOutcome,
} from "./release-surface-outcome-union";

export interface ReleaseSurfaceRecoveredEvidence {
  id: string;
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseSurfaceInterruptedRecovery {
  slice: ReleaseSurfaceOutcomeSlice;
  evidenceArtifacts: ReleaseSurfaceRecoveredEvidence[];
  artifact: ReleaseSurfaceFileIdentity;
  signatureStatus: "verified" | "digest-verified";
  incompleteDriverIds: string[];
}

export function recoverInterruptedReleaseSurfaceSlice(input: {
  sourceId: string;
  receiptsDir: string;
  driverRunDir: string;
  orchestrationPath: string;
  lifecyclePath: string;
  profileCleanupPath: string;
  candidateAttestationPath: string;
  signatureReceiptPath: string;
  installationReceiptPath: string;
  contract: FinalSurfaceContract;
  inventory: ReleaseSurfaceInventory;
  driverPlan: FinalSurfaceDriverPlan;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  rootDir: string;
}): ReleaseSurfaceInterruptedRecovery {
  const receiptsDir = resolve(input.receiptsDir);
  const driverRunDir = containedDirectory(receiptsDir, input.driverRunDir, "interrupted driver directory");
  const evidenceArtifacts: ReleaseSurfaceRecoveredEvidence[] = [];
  const evidenceIds = new Set<string>();
  const addEvidence = (id: string, path: string): ReleaseSurfaceFileIdentity => {
    if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(id) || evidenceIds.has(id)) {
      throw new Error(`interrupted recovery evidence id is invalid or duplicated: ${id}`);
    }
    evidenceIds.add(id);
    const identity = identifyContainedFile(receiptsDir, path, `interrupted recovery evidence ${id}`);
    evidenceArtifacts.push({ id, relativePath: identity.relativePath, sha256: identity.sha256, bytes: identity.bytes });
    return identity;
  };

  const candidateIdentity = addEvidence("candidate-attestation", input.candidateAttestationPath);
  const signatureIdentity = addEvidence("signature-receipt", input.signatureReceiptPath);
  const installationIdentity = addEvidence("installation-receipt", input.installationReceiptPath);
  const orchestrationIdentity = addEvidence("interrupted-orchestration", input.orchestrationPath);
  const lifecycleIdentity = addEvidence("interrupted-webdriver-lifecycle", input.lifecyclePath);
  const cleanupIdentity = addEvidence("interrupted-profile-cleanup", input.profileCleanupPath);
  const candidate = loadReleaseSurfaceCandidateAttestation(input.candidateAttestationPath);
  validateCandidateEvidence(input, candidate, signatureIdentity, installationIdentity);
  const signature = loadReleaseSurfaceSignatureReceipt(input.signatureReceiptPath);
  const orchestration = readJson<ReleaseSurfaceWebDriverOrchestrationReceipt>(input.orchestrationPath);
  const lifecycle = readJson<ReleaseSurfaceWebDriverLifecycleReceipt>(input.lifecyclePath);
  const cleanup = readJson<ReleaseSurfaceRunProfileCleanupReceipt>(input.profileCleanupPath);
  validateInterruptedCleanup({
    orchestration,
    orchestrationIdentity,
    lifecycle,
    lifecycleIdentity,
    cleanup,
    cleanupIdentity,
    candidate,
    candidateIdentity,
    platform: input.platform,
  });

  let nativeBinding: ReleaseSurfaceWebDriverBindingEvidence | null = null;
  let nativeBindingIdentity: ReleaseSurfaceFileIdentity | null = null;
  const nativeBindingPath = join(driverRunDir, "native-webdriver-binding.json");
  if (readdirSync(driverRunDir).includes("native-webdriver-binding.json")) {
    nativeBindingIdentity = addEvidence("native-webdriver-binding", nativeBindingPath);
    nativeBinding = readJson<ReleaseSurfaceWebDriverBindingEvidence>(nativeBindingPath);
  }
  const inventoryById = new Map(input.inventory.items.map((surface) => [surface.id, surface]));
  const driversById = new Map(input.driverPlan.drivers.map((driver) => [driver.id, driver]));
  const primaryRequests = readdirSync(driverRunDir)
    .filter((name) => name.endsWith(".request.json") && !name.includes(".part-"))
    .sort();
  if (primaryRequests.length === 0) throw new Error("interrupted recovery found no durable driver requests");
  const outcomes: ReleaseSurfaceSliceOutcome[] = [];
  const incompleteDriverIds: string[] = [];
  const observedOutcomeIds = new Set<string>();
  for (const requestName of primaryRequests) {
    const driverId = requestName.slice(0, -".request.json".length);
    const requestPath = join(driverRunDir, requestName);
    const reportPath = join(driverRunDir, `${driverId}.report.json`);
    const beforePath = join(driverRunDir, `${driverId}.runtime-before.json`);
    const afterPath = join(driverRunDir, `${driverId}.runtime-after.json`);
    const available = [reportPath, beforePath, afterPath].map(isRegularFile);
    if (!available.every(Boolean)) {
      incompleteDriverIds.push(driverId);
      addEvidence(`incomplete-request-${driverId}`, requestPath);
      if (available[0]) addEvidence(`incomplete-report-${driverId}`, reportPath);
      if (available[1]) addEvidence(`incomplete-runtime-before-${driverId}`, beforePath);
      if (available[2]) addEvidence(`incomplete-runtime-after-${driverId}`, afterPath);
      for (const part of readdirSync(driverRunDir)
        .filter((name) => name.startsWith(`${driverId}.part-`) && name.endsWith(".json"))
        .sort()) {
        addEvidence(`incomplete-part-${part.replace(/[^a-zA-Z0-9._-]/g, "-")}`, join(driverRunDir, part));
      }
      continue;
    }
    const request = readJson<ReleaseSurfaceDriverRequest>(requestPath);
    const report = readJson<ReleaseSurfaceDriverReport>(reportPath);
    const before = readJson<ReleaseSurfaceRuntimeProbe>(beforePath);
    const after = readJson<ReleaseSurfaceRuntimeProbe>(afterPath);
    validateRecoveredDriver({
      request,
      report,
      before,
      after,
      driverId,
      candidate,
      nativeBinding,
      nativeBindingIdentity,
      inventory: input.inventory,
      inventoryById,
      driverPlan: input.driverPlan,
      driversById,
      platform: input.platform,
      sourceCommit: input.sourceCommit,
      version: input.version,
      rootDir: input.rootDir,
    });
    addEvidence(`driver-request-${driverId}`, requestPath);
    addEvidence(`driver-report-${driverId}`, reportPath);
    addEvidence(`driver-runtime-before-${driverId}`, beforePath);
    addEvidence(`driver-runtime-after-${driverId}`, afterPath);
    for (const outcome of report.outcomes) {
      if (observedOutcomeIds.has(outcome.id)) throw new Error(`interrupted recovery repeats outcome ${outcome.id}`);
      observedOutcomeIds.add(outcome.id);
      outcomes.push({
        id: outcome.id,
        driverId,
        expectedEffect: outcome.expectedEffect,
        oracleId: outcome.oracleId,
        present: outcome.present,
        invoke: outcome.invoke,
        effect: outcome.effect,
        cleanup: outcome.cleanup === "deferred-candidate-teardown" ? "pass" : outcome.cleanup,
        observedEffect: outcome.observedEffect,
        evidenceId: `driver-report-${driverId}`,
        cleanupEvidenceId: outcome.cleanup === "deferred-candidate-teardown"
          ? "interrupted-profile-cleanup"
          : `driver-report-${driverId}`,
      });
    }
  }
  if (incompleteDriverIds.length === 0) {
    throw new Error("interrupted recovery requires at least one incomplete driver section; use the sealed run manifest otherwise");
  }
  if (outcomes.length === 0) throw new Error("interrupted recovery found no complete driver sections");
  return {
    slice: {
      sourceId: input.sourceId,
      sourceKind: "interrupted-discovery",
      platform: input.platform,
      sourceCommit: input.sourceCommit,
      version: input.version,
      inventoryDigest: input.inventory.digest,
      startedAt: orchestration.startedAt,
      completedAt: orchestration.completedAt,
      outcomes,
    },
    evidenceArtifacts,
    artifact: candidate.distributionArtifact,
    signatureStatus: signature.status,
    incompleteDriverIds,
  };
}

function validateCandidateEvidence(
  input: Parameters<typeof recoverInterruptedReleaseSurfaceSlice>[0],
  candidate: ReleaseSurfaceCandidateAttestation,
  signatureIdentity: ReleaseSurfaceFileIdentity,
  installationIdentity: ReleaseSurfaceFileIdentity,
): void {
  const candidateErrors = validateReleaseSurfaceCandidateAttestation({
    attestation: candidate,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact: candidate.distributionArtifact,
    installationReceipt: installationIdentity,
  });
  if (candidateErrors.length > 0) throw new Error(`interrupted candidate attestation is invalid: ${candidateErrors.join("; ")}`);
  if (!sameIdentity(candidate.installation.receipt, installationIdentity)) {
    throw new Error("interrupted candidate does not bind the exact installation receipt");
  }
  const installation = loadReleaseSurfaceInstallationReceipt(input.installationReceiptPath);
  const installationErrors = validateReleaseSurfaceInstallationReceipt({
    receipt: installation,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    method: candidate.installation.method,
    artifact: candidate.distributionArtifact,
    installedPayload: candidate.installedPayload,
  });
  if (installationErrors.length > 0) throw new Error(`interrupted installation receipt is invalid: ${installationErrors.join("; ")}`);
  if (installation.signatureReceipt && !sameIdentity(installation.signatureReceipt, signatureIdentity)) {
    throw new Error("interrupted installation does not bind the exact signature receipt");
  }
  const platformContract = input.contract.platforms[input.platform];
  if (!platformContract) throw new Error(`interrupted platform ${input.platform} is outside the final contract`);
  const signature = loadReleaseSurfaceSignatureReceipt(input.signatureReceiptPath);
  const signatureErrors = validateReleaseSurfaceSignatureReceipt({
    receipt: signature,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact: candidate.distributionArtifact,
    expectedStatus: platformContract.signatureStatus,
    requiredChecks: platformContract.requiredSignatureChecks,
  });
  if (signatureErrors.length > 0) throw new Error(`interrupted signature receipt is invalid: ${signatureErrors.join("; ")}`);
}

function validateInterruptedCleanup(input: {
  orchestration: ReleaseSurfaceWebDriverOrchestrationReceipt;
  orchestrationIdentity: ReleaseSurfaceFileIdentity;
  lifecycle: ReleaseSurfaceWebDriverLifecycleReceipt;
  lifecycleIdentity: ReleaseSurfaceFileIdentity;
  cleanup: ReleaseSurfaceRunProfileCleanupReceipt;
  cleanupIdentity: ReleaseSurfaceFileIdentity;
  candidate: ReleaseSurfaceCandidateAttestation;
  candidateIdentity: ReleaseSurfaceFileIdentity;
  platform: ReleasePlatform;
}): void {
  const { orchestration, lifecycle, cleanup, candidate } = input;
  if (orchestration.mode !== "final-frozen-candidate"
    || orchestration.status !== "failed"
    || orchestration.executionWindow !== "immediately-before-publish"
    || orchestration.platform !== input.platform
    || orchestration.workCompleted !== false
    || !validIsoRange(orchestration.startedAt, orchestration.completedAt)
    || !orchestration.error?.trim()) {
    throw new Error("interrupted orchestration does not prove a bounded incomplete discovery run");
  }
  if (!orchestration.candidateAttestation
    || !sameIdentity(orchestration.candidateAttestation, input.candidateIdentity)
    || !orchestration.webdriverLifecycle
    || !sameIdentity(orchestration.webdriverLifecycle, input.lifecycleIdentity)
    || orchestration.webdriverLifecycle.status !== "failed"
    || !orchestration.profileCleanup
    || !sameIdentity(orchestration.profileCleanup, input.cleanupIdentity)
    || orchestration.profileCleanup.status !== "pass") {
    throw new Error("interrupted orchestration evidence identities are incomplete or drifted");
  }
  if (!orchestration.application.bound
    || orchestration.application.processId !== candidate.runtime.processId
    || orchestration.application.executableSha256 !== candidate.process.executableSha256) {
    throw new Error("interrupted orchestration application binding does not match the candidate");
  }
  if (lifecycle.mode !== "final-frozen-candidate"
    || lifecycle.status !== "failed"
    || lifecycle.session.created !== true
    || lifecycle.session.workCompleted !== false
    || lifecycle.cleanup.sessionDeleted !== "pass"
    || lifecycle.cleanup.driverStopped !== "pass"
    || !validIsoRange(lifecycle.startedAt, lifecycle.completedAt)
    || lifecycle.application.sha256 !== candidate.process.executableSha256) {
    throw new Error("interrupted WebDriver lifecycle does not prove exact failed work and successful native cleanup");
  }
  if (cleanup.mode !== "final-frozen-candidate"
    || cleanup.status !== "pass"
    || cleanup.platform !== input.platform
    || cleanup.runId !== orchestration.runId
    || cleanup.application.processCountAfter !== 0
    || cleanup.nativeDriver.processCountAfter !== 0
    || cleanup.listeners.debugCountAfter !== 0
    || cleanup.listeners.mcpCountAfter !== 0
    || cleanup.profile.markerVerified !== true
    || cleanup.profile.removed !== true
    || !validIsoRange(cleanup.startedAt, cleanup.completedAt)
    || Date.parse(cleanup.completedAt) > Date.parse(orchestration.completedAt)) {
    throw new Error("interrupted profile cleanup does not prove zero residual candidate state");
  }
  if (cleanup.application.processId !== undefined && cleanup.application.processId !== candidate.runtime.processId) {
    throw new Error("interrupted profile cleanup process id does not match the candidate");
  }
  if (!cleanup.application.alreadyStopped && !cleanup.application.identityVerifiedBeforeStop) {
    throw new Error("interrupted profile cleanup stopped a process without exact identity verification");
  }
}

function validateRecoveredDriver(input: {
  request: ReleaseSurfaceDriverRequest;
  report: ReleaseSurfaceDriverReport;
  before: ReleaseSurfaceRuntimeProbe;
  after: ReleaseSurfaceRuntimeProbe;
  driverId: string;
  candidate: ReleaseSurfaceCandidateAttestation;
  nativeBinding: ReleaseSurfaceWebDriverBindingEvidence | null;
  nativeBindingIdentity: ReleaseSurfaceFileIdentity | null;
  inventory: ReleaseSurfaceInventory;
  inventoryById: Map<string, ReleaseSurfaceInventory["items"][number]>;
  driverPlan: FinalSurfaceDriverPlan;
  driversById: Map<string, FinalSurfaceDriverPlan["drivers"][number]>;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  rootDir: string;
}): void {
  const driver = input.driversById.get(input.driverId);
  if (!driver || !driverReadyOnPlatform(driver, input.platform)) {
    throw new Error(`interrupted recovery contains undeclared driver ${input.driverId}`);
  }
  const described = describeReadyDriver(input.rootDir, driver);
  if (typeof described === "string") throw new Error(described);
  const requestErrors = validateReleaseSurfaceDriverRequest(described, input.request);
  if (requestErrors.length > 0) throw new Error(`interrupted driver ${input.driverId} request is invalid: ${requestErrors.join("; ")}`);
  const reportErrors = validateReleaseSurfaceDriverReport(input.request, input.report);
  if (reportErrors.length > 0) throw new Error(`interrupted driver ${input.driverId} report is invalid: ${reportErrors.join("; ")}`);
  const controllerErrors = verifyReleaseSurfaceControllerBindingFromGit({ rootDir: input.rootDir, binding: input.request.controller });
  if (controllerErrors.length > 0) throw new Error(`interrupted driver ${input.driverId} controller is invalid: ${controllerErrors.join("; ")}`);
  for (const [field, expected, actual] of [
    ["driverId", input.driverId, input.request.driverId],
    ["platform", input.platform, input.request.platform],
    ["sourceCommit", input.sourceCommit, input.request.sourceCommit],
    ["version", input.version, input.request.version],
    ["inventoryDigest", input.inventory.digest, input.request.inventoryDigest],
  ] as const) {
    if (expected !== actual) throw new Error(`interrupted driver ${input.driverId} ${field} drifted`);
  }
  if (input.request.controller.entrypoint.relativePath !== driver.entrypoint
    || input.request.artifact.sha256 !== input.candidate.distributionArtifact.sha256
    || input.request.runtime.processId !== input.candidate.runtime.processId
    || input.request.runtime.instanceId !== input.candidate.runtime.instanceId
    || input.request.runtime.executableSha256 !== input.candidate.process.executableSha256
    || input.request.runtime.installedManifestSha256 !== input.candidate.installation.payloadManifestSha256) {
    throw new Error(`interrupted driver ${input.driverId} does not bind the exact candidate runtime`);
  }
  if (input.request.nativeWebDriver) {
    if (!input.nativeBinding || !input.nativeBindingIdentity
      || !sameIdentity(input.request.nativeWebDriver.evidence, input.nativeBindingIdentity)) {
      throw new Error(`interrupted driver ${input.driverId} native WebDriver evidence is missing or drifted`);
    }
    const bindingErrors = validateReleaseSurfaceWebDriverBinding({
      evidence: input.nativeBinding,
      candidate: input.candidate,
      session: input.request.nativeWebDriver,
    });
    if (bindingErrors.length > 0) throw new Error(`interrupted driver ${input.driverId} native WebDriver binding is invalid: ${bindingErrors.join("; ")}`);
  }
  if (input.request.macosNativeInput) throw new Error("interrupted macOS native-input recovery is not implemented");
  const expectedIds = input.driverPlan.assignments
    .filter((row) => row.driverId === input.driverId
      && input.inventoryById.get(row.surfaceId)?.platforms.includes(input.platform))
    .map((row) => row.surfaceId)
    .sort();
  const actualIds = input.request.assignments.map((row) => row.surface.id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error(`interrupted driver ${input.driverId} request does not contain its exact discovery assignments`);
  }
  for (const row of input.request.assignments) {
    const assignment = input.driverPlan.assignments.find((candidate) => (
      candidate.driverId === input.driverId && candidate.surfaceId === row.surface.id
    ));
    const surface = input.inventoryById.get(row.surface.id);
    if (!assignment || !surface
      || assignment.fixtureId !== row.fixtureId
      || assignment.expectedEffect !== row.expectedEffect
      || assignment.oracleId !== row.oracleId
      || assignment.cleanupId !== row.cleanupId
      || JSON.stringify(surface) !== JSON.stringify(row.surface)) {
      throw new Error(`interrupted driver ${input.driverId} assignment ${row.surface.id} drifted`);
    }
  }
  const beforeErrors = validateReleaseSurfaceRuntimeProbe(input.before, input.request, "before-driver");
  const afterErrors = validateReleaseSurfaceRuntimeProbe(input.after, input.request, "after-driver");
  if (beforeErrors.length > 0 || afterErrors.length > 0
    || Date.parse(input.before.observedAt) > Date.parse(input.report.startedAt)
    || Date.parse(input.after.observedAt) < Date.parse(input.report.completedAt)) {
    throw new Error(`interrupted driver ${input.driverId} runtime probes do not bracket valid evidence`);
  }
  if (input.report.outcomes.length !== input.request.assignments.length) {
    throw new Error(`interrupted driver ${input.driverId} outcome count does not match assignments`);
  }
  void releaseSurfaceDriverPhaseReportPassed(input.report);
}

function identifyContainedFile(root: string, path: string, label: string): ReleaseSurfaceFileIdentity & { relativePath: string } {
  const absolute = containedPath(root, path, label);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0) throw new Error(`${label} must not be empty`);
  return {
    basename: basename(absolute),
    relativePath: relative(root, absolute).split(sep).join("/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function containedDirectory(root: string, path: string, label: string): string {
  const absolute = containedPath(root, path, label);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular non-symlink directory`);
  return absolute;
}

function containedPath(root: string, path: string, label: string): string {
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`${label} must be inside the private receipts directory`);
  }
  return absolute;
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function sameIdentity(
  left: Pick<ReleaseSurfaceFileIdentity, "basename" | "sha256" | "bytes">,
  right: Pick<ReleaseSurfaceFileIdentity, "basename" | "sha256" | "bytes">,
): boolean {
  return left.basename === right.basename && left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function validIsoRange(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}
