import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  assignmentCellKey,
  describeReadyDriver,
  driverReadyOnPlatform,
  verifyFinalSurfaceDriverPlan,
  type FinalSurfaceDriverPlan,
} from "./release-surface-driver-plan";
import {
  RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  releaseSurfaceDriverPhaseReportPassed,
  validateReleaseSurfaceDriverRequest,
  validateReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./release-surface-driver-protocol";
import {
  RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
  type ReleaseSurfaceDriverRunManifest,
} from "./release-surface-driver-runner";
import {
  FINAL_SURFACE_RECEIPT_SCHEMA,
  type FinalSurfaceContract,
  type FinalSurfaceReceipt,
} from "./release-surface-receipts";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";
import {
  loadReleaseSurfaceCandidateAttestation,
  validateReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./release-surface-candidate-attestation";
import {
  loadReleaseSurfaceInstallationReceipt,
  validateReleaseSurfaceEvidenceTimeline,
  validateReleaseSurfaceInstallationReceipt,
} from "./release-surface-installation-receipt";
import {
  loadReleaseSurfaceSignatureReceipt,
  validateReleaseSurfaceSignatureReceipt,
} from "./release-surface-signature-receipt";
import {
  loadReleaseSurfaceScenarioReport,
  validateReleaseSurfaceScenarioReport,
} from "./release-surface-scenario-report";
import {
  loadReleaseSurfaceProviderRouteEvidence,
  validateReleaseSurfaceProviderRouteEvidence,
} from "./release-surface-provider-route-evidence";
import {
  loadReleaseSurfaceHealthEvidence,
  validateReleaseSurfaceHealthEvidence,
} from "./release-surface-health-evidence";
import {
  validateReleaseSurfaceRuntimeProbe,
  type ReleaseSurfaceRuntimeProbe,
} from "./release-surface-runtime-candidate";
import {
  toReleaseSurfaceWindowsNativeBinding,
  validateReleaseSurfaceWindowsProbeOrder,
} from "./release-surface-windows-native-runtime";
import {
  toReleaseSurfacePosixNativeBinding,
  validateReleaseSurfacePosixProbeOrder,
} from "./release-surface-posix-native-runtime";
import {
  releaseSurfaceDriverRequiresNativeWebDriver,
  releaseSurfaceDriverSupportsMacosNativeInput,
  validateReleaseSurfaceWebDriverBinding,
  type ReleaseSurfaceWebDriverBindingEvidence,
} from "./release-surface-webdriver-binding";
import {
  validateReleaseSurfaceControllerBinding,
  verifyReleaseSurfaceControllerBinding,
} from "./release-surface-controller-binding";
import {
  validateReleaseSurfaceMacosNativeInputBinding,
  type ReleaseSurfaceMacosNativeInputBindingEvidence,
  type ReleaseSurfaceMacosNativeInputRequestBinding,
} from "./release-surface-macos-native-input";
import {
  loadReleaseSurfaceCandidateTeardownReceipt,
  validateReleaseSurfaceCandidateTeardownReceipt,
} from "./release-surface-candidate-teardown";
import type { ReleaseSurfaceWebDriverLifecycleReceipt } from "./release-surface-webdriver-lifecycle";
import type { ReleaseSurfaceRunProfileCleanupReceipt } from "./release-surface-run-profile";

function requirePassingVerdict(value: "pass" | "fail", surfaceId: string, phase: string): "pass" {
  if (value !== "pass") throw new Error(`surface ${surfaceId} ${phase} verdict is not pass`);
  return value;
}

export interface ComposeFinalSurfaceReceiptInput {
  receiptsDir: string;
  driverRunDir: string;
  scenarioReportPath: string;
  signatureReceiptPath: string;
  candidateAttestationPath: string;
  candidateTeardownPath?: string;
  installationReceiptPath: string;
  contract: FinalSurfaceContract;
  inventory: ReleaseSurfaceInventory;
  driverPlan: FinalSurfaceDriverPlan;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  rootDir: string;
}

export function composeFinalSurfaceReceipt(input: ComposeFinalSurfaceReceiptInput): FinalSurfaceReceipt {
  const receiptsDir = resolve(input.receiptsDir);
  requireContainedDirectory(receiptsDir, input.driverRunDir, "driver run directory");
  const driverRunDir = resolve(input.driverRunDir);
  const platformContract = input.contract.platforms[input.platform];
  if (!platformContract) throw new Error(`platform ${input.platform} is outside the final surface contract`);

  const planResult = verifyFinalSurfaceDriverPlan(input.driverPlan, input.inventory, input.rootDir);
  if (planResult.status !== "ready") {
    throw new Error(`final surface driver plan is ${planResult.status}; ready ${planResult.counts.ready}/${planResult.counts.inventoryCells} platform cells`);
  }

  const runManifestPath = join(driverRunDir, "run-manifest.json");
  const runManifest = JSON.parse(readFileSync(runManifestPath, "utf8")) as ReleaseSurfaceDriverRunManifest;
  const runManifestIdentity = identifyContainedFile(receiptsDir, runManifestPath, "driver run manifest");
  validateRunManifest(runManifest, input);
  const signatureReceipt = identifyContainedFile(receiptsDir, input.signatureReceiptPath, "signature receipt");
  if (signatureReceipt.basename !== runManifest.signatureReceipt.basename
    || signatureReceipt.sha256 !== runManifest.signatureReceipt.sha256
    || signatureReceipt.bytes !== runManifest.signatureReceipt.bytes) {
    throw new Error("signature receipt does not match the exact file identity recorded by the driver run");
  }
  const parsedSignatureReceipt = loadReleaseSurfaceSignatureReceipt(input.signatureReceiptPath);
  const signatureErrors = validateReleaseSurfaceSignatureReceipt({
    receipt: parsedSignatureReceipt,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact: runManifest.artifact,
    expectedStatus: platformContract.signatureStatus,
    requiredChecks: platformContract.requiredSignatureChecks,
  });
  if (signatureErrors.length > 0) throw new Error(`invalid candidate signature receipt: ${signatureErrors.join("; ")}`);
  const signatureChecks = parsedSignatureReceipt.checks.map((check) => check.id).sort();
  if (runManifest.signatureVerification?.status !== parsedSignatureReceipt.status
    || JSON.stringify(runManifest.signatureVerification?.checks) !== JSON.stringify(signatureChecks)) {
    throw new Error("signature verification summary does not match the exact parsed signature receipt");
  }
  const candidateAttestationIdentity = identifyContainedFile(
    receiptsDir,
    input.candidateAttestationPath,
    "candidate attestation",
  );
  if (candidateAttestationIdentity.basename !== runManifest.candidateAttestation.basename
    || candidateAttestationIdentity.sha256 !== runManifest.candidateAttestation.sha256
    || candidateAttestationIdentity.bytes !== runManifest.candidateAttestation.bytes) {
    throw new Error("candidate attestation does not match the exact file identity recorded by the driver run");
  }
  const installationReceiptIdentity = identifyContainedFile(
    receiptsDir,
    input.installationReceiptPath,
    "installation receipt",
  );
  if (installationReceiptIdentity.basename !== runManifest.installationReceipt.basename
      || installationReceiptIdentity.sha256 !== runManifest.installationReceipt.sha256
      || installationReceiptIdentity.bytes !== runManifest.installationReceipt.bytes) {
    throw new Error("installation receipt does not match the exact file identity recorded by the driver run");
  }
  const parsedCandidateAttestation = loadReleaseSurfaceCandidateAttestation(input.candidateAttestationPath);
  const candidateErrors = validateReleaseSurfaceCandidateAttestation({
    attestation: parsedCandidateAttestation,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact: runManifest.artifact,
    installationReceipt: installationReceiptIdentity,
  });
  if (candidateErrors.length > 0) throw new Error(`invalid candidate attestation: ${candidateErrors.join("; ")}`);
  const parsedInstallationReceipt = loadReleaseSurfaceInstallationReceipt(input.installationReceiptPath);
  const installationErrors = validateReleaseSurfaceInstallationReceipt({
    receipt: parsedInstallationReceipt,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    method: parsedCandidateAttestation.installation.method,
    artifact: runManifest.artifact,
    installedPayload: parsedCandidateAttestation.installedPayload,
  });
  if (installationErrors.length > 0) throw new Error(`invalid installation receipt: ${installationErrors.join("; ")}`);
  if (parsedCandidateAttestation.installation.payloadManifestSha256
    !== parsedInstallationReceipt.payloadManifest.manifestSha256) {
    throw new Error("candidate attestation payload manifest digest does not match installation receipt");
  }
  const timelineErrors = validateReleaseSurfaceEvidenceTimeline({
    installationCreatedAt: parsedInstallationReceipt.createdAt,
    attestationCreatedAt: parsedCandidateAttestation.createdAt,
    runStartedAt: runManifest.startedAt,
  });
  if (timelineErrors.length > 0) throw new Error(`invalid candidate evidence timeline: ${timelineErrors.join("; ")}`);
  if (runManifest.candidateVerification?.installedPayloadSha256 !== parsedCandidateAttestation.installedPayload.sha256
    || runManifest.candidateVerification?.installedManifestSha256 !== parsedInstallationReceipt.payloadManifest.manifestSha256
    || runManifest.candidateVerification?.processId !== parsedCandidateAttestation.runtime.processId
    || runManifest.candidateVerification?.instanceId !== parsedCandidateAttestation.runtime.instanceId
    || runManifest.candidateVerification?.debugBase !== parsedCandidateAttestation.runtime.debugBase
    || runManifest.candidateVerification?.debugTokenPath !== parsedCandidateAttestation.runtime.debugTokenPath
    || runManifest.candidateVerification?.mcpBase !== parsedCandidateAttestation.runtime.mcpBase
    || runManifest.candidateVerification?.mcpTokenPath !== parsedCandidateAttestation.runtime.mcpTokenPath
    || runManifest.candidateVerification?.buildCommit !== parsedCandidateAttestation.runtime.buildCommit
    || JSON.stringify(runManifest.candidateVerification?.windowsNative)
      !== JSON.stringify(parsedCandidateAttestation.windowsNativeRuntime
        ? toReleaseSurfaceWindowsNativeBinding(parsedCandidateAttestation.windowsNativeRuntime)
        : undefined)
    || JSON.stringify(runManifest.candidateVerification?.posixNative)
      !== JSON.stringify(parsedCandidateAttestation.posixNativeRuntime
        ? toReleaseSurfacePosixNativeBinding(parsedCandidateAttestation.posixNativeRuntime)
        : undefined)) {
    throw new Error("candidate verification summary does not match the exact parsed attestation");
  }

  identifyContainedFile(receiptsDir, input.scenarioReportPath, "scenario report");
  const scenarioReport = loadReleaseSurfaceScenarioReport(input.scenarioReportPath);
  const scenarioErrors = validateReleaseSurfaceScenarioReport({
    report: scenarioReport,
    contract: input.contract,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    inventoryDigest: input.inventory.digest,
    artifactSha256: runManifest.artifact.sha256,
  });
  if (scenarioErrors.length > 0) throw new Error(`invalid final scenario report: ${scenarioErrors.join("; ")}`);

  const evidenceArtifacts: FinalSurfaceReceipt["evidenceArtifacts"] = [];
  const addEvidence = (id: string, path: string): string => {
    const identity = identifyContainedFile(receiptsDir, path, `evidence ${id}`);
    if (evidenceArtifacts.some((artifact) => artifact.id === id)) throw new Error(`evidence id ${id} is duplicated`);
    evidenceArtifacts.push({ id, relativePath: identity.relativePath, sha256: identity.sha256, bytes: identity.bytes });
    return id;
  };
  addEvidence("driver-run-manifest", runManifestPath);
  addEvidence("signature-receipt", input.signatureReceiptPath);
  addEvidence("candidate-attestation", input.candidateAttestationPath);
  addEvidence("installation-receipt", input.installationReceiptPath);
  const candidateTeardownPath = resolve(
    input.candidateTeardownPath ?? join(dirname(input.candidateAttestationPath), "candidate-teardown.json"),
  );
  const candidateTeardownIdentity = identifyContainedFile(
    receiptsDir,
    candidateTeardownPath,
    "candidate teardown receipt",
  );
  const parsedCandidateTeardown = loadReleaseSurfaceCandidateTeardownReceipt(candidateTeardownPath);
  const teardownDirectory = dirname(candidateTeardownPath);
  const profileCleanupPath = join(teardownDirectory, parsedCandidateTeardown.profileCleanup.basename);
  const profileCleanupIdentity = identifyContainedFile(
    receiptsDir,
    profileCleanupPath,
    "candidate teardown profile cleanup",
  );
  const webdriverLifecyclePath = parsedCandidateTeardown.webdriverLifecycle
    ? join(teardownDirectory, parsedCandidateTeardown.webdriverLifecycle.basename)
    : null;
  const webdriverLifecycleIdentity = webdriverLifecyclePath
    ? identifyContainedFile(receiptsDir, webdriverLifecyclePath, "candidate teardown WebDriver lifecycle")
    : null;
  const parsedWebdriverLifecycle = webdriverLifecyclePath
    ? JSON.parse(readFileSync(webdriverLifecyclePath, "utf8")) as ReleaseSurfaceWebDriverLifecycleReceipt
    : null;
  const parsedProfileCleanup = JSON.parse(
    readFileSync(profileCleanupPath, "utf8"),
  ) as ReleaseSurfaceRunProfileCleanupReceipt;
  const candidateTeardownEvidenceId = addEvidence("candidate-teardown", candidateTeardownPath);
  if (webdriverLifecyclePath) addEvidence("webdriver-lifecycle", webdriverLifecyclePath);
  addEvidence("run-profile-cleanup", profileCleanupPath);
  let parsedWebDriverBinding: ReleaseSurfaceWebDriverBindingEvidence | null = null;
  let nativeWebDriverBindingUsed = false;
  if (runManifest.nativeWebDriverBinding) {
    const bindingPath = join(driverRunDir, runManifest.nativeWebDriverBinding.basename);
    requireExactIdentity(
      identifyContainedFile(receiptsDir, bindingPath, "native WebDriver binding evidence"),
      runManifest.nativeWebDriverBinding,
      "native WebDriver binding evidence",
    );
    parsedWebDriverBinding = JSON.parse(readFileSync(bindingPath, "utf8")) as ReleaseSurfaceWebDriverBindingEvidence;
    addEvidence("native-webdriver-binding", bindingPath);
  }
  let parsedMacosNativeInputBinding: ReleaseSurfaceMacosNativeInputBindingEvidence | null = null;
  let macosNativeInputBindingUsed = false;
  if (runManifest.macosNativeInputBinding) {
    const bindingPath = join(driverRunDir, runManifest.macosNativeInputBinding.basename);
    requireExactIdentity(
      identifyContainedFile(receiptsDir, bindingPath, "macOS native-input binding evidence"),
      runManifest.macosNativeInputBinding,
      "macOS native-input binding evidence",
    );
    parsedMacosNativeInputBinding = JSON.parse(readFileSync(bindingPath, "utf8")) as ReleaseSurfaceMacosNativeInputBindingEvidence;
    addEvidence("macos-native-input-binding", bindingPath);
  }
  const scenarioEvidenceId = addEvidence("scenario-report", input.scenarioReportPath);
  const healthEvidencePath = releaseSurfaceScenarioEvidencePath(
    input.scenarioReportPath,
    scenarioReport.health.evidence.basename,
  );
  const actualHealthEvidence = identifyContainedFile(receiptsDir, healthEvidencePath, "scenario health evidence");
  requireExactIdentity(actualHealthEvidence, scenarioReport.health.evidence, "scenario health evidence");
  const parsedHealthEvidence = loadReleaseSurfaceHealthEvidence(healthEvidencePath);
  const expectedLinkSurfaceIds = new Set(input.inventory.items
    .filter((surface) => surface.kind === "ui-control"
      && surface.elementTag === "a"
      && surface.platforms.includes(input.platform))
    .map((surface) => surface.id));
  const healthEvidenceErrors = validateReleaseSurfaceHealthEvidence({
    evidence: parsedHealthEvidence,
    candidate: parsedCandidateAttestation,
    scenario: scenarioReport,
    knownSurfaceIds: new Set(input.inventory.items.map((surface) => surface.id)),
    ...(expectedLinkSurfaceIds.size > 0 ? { expectedLinkSurfaceIds } : {}),
  });
  if (healthEvidenceErrors.length > 0) {
    throw new Error(`invalid scenario health evidence: ${healthEvidenceErrors.join("; ")}`);
  }
  const healthEvidenceId = addEvidence("scenario-health", healthEvidencePath);
  const routeVersionsByProvider = new Map<string, Set<string>>();
  const routeEvidenceIds = new Map<string, string>();
  for (const route of scenarioReport.providerRoutes) {
    const routeEvidencePath = releaseSurfaceScenarioEvidencePath(
      input.scenarioReportPath,
      route.evidence.basename,
    );
    const actualEvidence = identifyContainedFile(receiptsDir, routeEvidencePath, `provider route ${route.id} evidence`);
    requireExactIdentity(actualEvidence, route.evidence, `provider route ${route.id} evidence`);
    const parsedRouteEvidence = loadReleaseSurfaceProviderRouteEvidence(routeEvidencePath);
    const routeEvidenceErrors = validateReleaseSurfaceProviderRouteEvidence({
      evidence: parsedRouteEvidence,
      candidate: parsedCandidateAttestation,
      expectedRoute: route,
    });
    if (routeEvidenceErrors.length > 0) {
      throw new Error(`invalid provider route ${route.id} evidence: ${routeEvidenceErrors.join("; ")}`);
    }
    const routeEvidenceId = addEvidence(`provider-route-${route.id}`, routeEvidencePath);
    routeEvidenceIds.set(route.id, routeEvidenceId);
    const versions = routeVersionsByProvider.get(route.providerId) ?? new Set<string>();
    versions.add(route.provider.version);
    routeVersionsByProvider.set(route.providerId, versions);
  }

  const driverDefinitions = new Map(input.driverPlan.drivers.map((driver) => [driver.id, driver]));
  const inventoryById = new Map(input.inventory.items.map((surface) => [surface.id, surface]));
  const planAssignments = new Map(input.driverPlan.assignments.flatMap((assignment) => {
    const surface = inventoryById.get(assignment.surfaceId);
    const driver = driverDefinitions.get(assignment.driverId);
    return (surface?.platforms ?? []).filter((platform) => driver?.platforms[platform]).map(
      (platform) => [assignmentCellKey(assignment.surfaceId, platform), assignment] as const,
    );
  }));
  const seenDrivers = new Set<string>();
  const outcomes: FinalSurfaceReceipt["outcomes"] = [];
  const seenOutcomes = new Set<string>();

  for (const row of runManifest.driverReports) {
    if (seenDrivers.has(row.driverId)) throw new Error(`driver run manifest repeats ${row.driverId}`);
    seenDrivers.add(row.driverId);
    const driver = driverDefinitions.get(row.driverId);
    if (!driver || !driverReadyOnPlatform(driver, input.platform)) {
      throw new Error(`driver run contains undeclared or non-ready ${input.platform} driver ${row.driverId}`);
    }
    const requestPath = join(driverRunDir, `${row.driverId}.request.json`);
    const reportPath = join(driverRunDir, `${row.driverId}.report.json`);
    const reportIdentity = identifyContainedFile(receiptsDir, reportPath, `driver ${row.driverId} report`);
    if (reportIdentity.basename !== row.basename || reportIdentity.sha256 !== row.sha256 || reportIdentity.bytes !== row.bytes) {
      throw new Error(`driver ${row.driverId} report identity does not match the run manifest`);
    }
    addEvidence(`driver-request-${row.driverId}`, requestPath);
    const reportEvidenceId = addEvidence(`driver-report-${row.driverId}`, reportPath);
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReleaseSurfaceDriverRequest;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
    const described = describeReadyDriver(input.rootDir, driver);
    if (typeof described === "string") throw new Error(described);
    const requestErrors = validateReleaseSurfaceDriverRequest(described, request);
    if (requestErrors.length > 0) {
      throw new Error(`driver ${row.driverId} request is invalid: ${requestErrors.join("; ")}`);
    }
    if (JSON.stringify(row.controller) !== JSON.stringify(request.controller)) {
      throw new Error(`driver ${row.driverId} request controller does not match the exact run manifest`);
    }
    const controllerErrors = verifyReleaseSurfaceControllerBinding({
      rootDir: input.rootDir,
      binding: row.controller,
      requireClean: true,
    });
    if (controllerErrors.length > 0) {
      throw new Error(`driver ${row.driverId} controller binding is invalid: ${controllerErrors.join("; ")}`);
    }
    if (request.nativeWebDriver) {
      if (!runManifest.nativeWebDriverBinding || !parsedWebDriverBinding) {
        throw new Error(`driver ${row.driverId} names a native WebDriver session without run binding evidence`);
      }
      requireExactIdentity(request.nativeWebDriver.evidence, runManifest.nativeWebDriverBinding, "native WebDriver request binding");
      const bindingErrors = validateReleaseSurfaceWebDriverBinding({
        evidence: parsedWebDriverBinding,
        candidate: parsedCandidateAttestation,
        session: request.nativeWebDriver,
      });
      if (bindingErrors.length > 0) {
        throw new Error(`driver ${row.driverId} native WebDriver binding is invalid: ${bindingErrors.join("; ")}`);
      }
      nativeWebDriverBindingUsed = true;
    }
    if (request.macosNativeInput) {
      const bindingErrors = validateReleaseSurfaceMacosNativeInputComposition({
        request: request.macosNativeInput,
        runBinding: runManifest.macosNativeInputBinding,
        evidence: parsedMacosNativeInputBinding,
        candidate: parsedCandidateAttestation,
      });
      if (bindingErrors.length > 0) {
        throw new Error(`driver ${row.driverId} macOS native-input binding is invalid: ${bindingErrors.join("; ")}`);
      }
      macosNativeInputBindingUsed = true;
    }
    const beforeProbePath = join(driverRunDir, row.beforeProbe.basename);
    const afterProbePath = join(driverRunDir, row.afterProbe.basename);
    requireExactIdentity(
      identifyContainedFile(receiptsDir, beforeProbePath, `driver ${row.driverId} before probe`),
      row.beforeProbe,
      `driver ${row.driverId} before probe`,
    );
    requireExactIdentity(
      identifyContainedFile(receiptsDir, afterProbePath, `driver ${row.driverId} after probe`),
      row.afterProbe,
      `driver ${row.driverId} after probe`,
    );
    addEvidence(`driver-runtime-before-${row.driverId}`, beforeProbePath);
    addEvidence(`driver-runtime-after-${row.driverId}`, afterProbePath);
    const beforeProbe = JSON.parse(readFileSync(beforeProbePath, "utf8")) as ReleaseSurfaceRuntimeProbe;
    const afterProbe = JSON.parse(readFileSync(afterProbePath, "utf8")) as ReleaseSurfaceRuntimeProbe;
    const beforeProbeErrors = validateReleaseSurfaceRuntimeProbe(beforeProbe, request, "before-driver");
    const afterProbeErrors = validateReleaseSurfaceRuntimeProbe(afterProbe, request, "after-driver");
    if (beforeProbeErrors.length > 0 || afterProbeErrors.length > 0) {
      throw new Error(`driver ${row.driverId} runtime probes are invalid: ${[...beforeProbeErrors, ...afterProbeErrors].join("; ")}`);
    }
    if (parsedCandidateAttestation.windowsNativeRuntime) {
      if (!beforeProbe.windowsNativeRuntime || !afterProbe.windowsNativeRuntime) {
        throw new Error(`driver ${row.driverId} is missing Windows native runtime probes`);
      }
      const nativeOrderErrors = validateReleaseSurfaceWindowsProbeOrder({
        attestedAt: parsedCandidateAttestation.windowsNativeRuntime.observedAt,
        beforeAt: beforeProbe.windowsNativeRuntime.observedAt,
        afterAt: afterProbe.windowsNativeRuntime.observedAt,
      });
      if (nativeOrderErrors.length > 0) {
        throw new Error(`driver ${row.driverId} Windows native probe order is invalid: ${nativeOrderErrors.join("; ")}`);
      }
    }
    if (parsedCandidateAttestation.posixNativeRuntime) {
      if (!beforeProbe.posixNativeRuntime || !afterProbe.posixNativeRuntime) {
        throw new Error(`driver ${row.driverId} is missing POSIX native runtime probes`);
      }
      const nativeOrderErrors = validateReleaseSurfacePosixProbeOrder({
        attestedAt: parsedCandidateAttestation.posixNativeRuntime.observedAt,
        beforeAt: beforeProbe.posixNativeRuntime.observedAt,
        afterAt: afterProbe.posixNativeRuntime.observedAt,
      });
      if (nativeOrderErrors.length > 0) {
        throw new Error(`driver ${row.driverId} POSIX native probe order is invalid: ${nativeOrderErrors.join("; ")}`);
      }
    }
    validateDriverRequestAgainstPlan(
      request,
      row.driverId,
      driver,
      input,
      planAssignments,
      inventoryById,
      runManifest,
      parsedCandidateAttestation,
    );
    const reportErrors = validateReleaseSurfaceDriverReport(request, report);
    if (reportErrors.length > 0) throw new Error(`driver ${row.driverId} report is invalid: ${reportErrors.join("; ")}`);
    if (!releaseSurfaceDriverPhaseReportPassed(report)) {
      throw new Error(`driver ${row.driverId} report contains failed outcomes`);
    }
    if (Date.parse(beforeProbe.observedAt) > Date.parse(report.startedAt)
      || Date.parse(afterProbe.observedAt) < Date.parse(report.completedAt)) {
      throw new Error(`driver ${row.driverId} runtime probes do not bracket its execution`);
    }
    if (report.outcomes.length !== row.outcomes) throw new Error(`driver ${row.driverId} outcome count does not match the run manifest`);
    for (const outcome of report.outcomes) {
      if (seenOutcomes.has(outcome.id)) throw new Error(`surface ${outcome.id} appears in more than one driver report`);
      seenOutcomes.add(outcome.id);
      outcomes.push({
        id: outcome.id,
        expectedEffect: outcome.expectedEffect,
        oracleId: outcome.oracleId,
        present: requirePassingVerdict(outcome.present, outcome.id, "present"),
        invoke: requirePassingVerdict(outcome.invoke, outcome.id, "invoke"),
        effect: requirePassingVerdict(outcome.effect, outcome.id, "effect"),
        cleanup: outcome.cleanup === "deferred-candidate-teardown"
          ? "pass"
          : requirePassingVerdict(outcome.cleanup, outcome.id, "cleanup"),
        evidence: reportEvidenceId,
        cleanupEvidence: outcome.cleanup === "deferred-candidate-teardown"
          ? candidateTeardownEvidenceId
          : reportEvidenceId,
        observedEffect: outcome.observedEffect,
      });
    }
  }

  const applicableSurfaceIds = new Set(input.inventory.items
    .filter((surface) => surface.platforms.includes(input.platform))
    .map((surface) => surface.id));
  const readyDriverIds = input.driverPlan.drivers
    .filter((driver) => driverReadyOnPlatform(driver, input.platform) && input.driverPlan.assignments.some(
      (assignment) => assignment.driverId === driver.id && applicableSurfaceIds.has(assignment.surfaceId),
    ))
    .map((driver) => driver.id)
    .sort();
  const observedDriverIds = [...seenDrivers].sort();
  if (JSON.stringify(readyDriverIds) !== JSON.stringify(observedDriverIds)) {
    throw new Error("driver run does not contain every exact ready driver once");
  }
  if (Boolean(runManifest.nativeWebDriverBinding) !== nativeWebDriverBindingUsed) {
    throw new Error("native WebDriver binding evidence must be consumed by at least one exact driver request");
  }
  if (Boolean(runManifest.macosNativeInputBinding) !== macosNativeInputBindingUsed) {
    throw new Error("macOS native-input binding evidence must be consumed by at least one exact driver request");
  }
  const candidateTeardownErrors = validateReleaseSurfaceCandidateTeardownReceipt({
    receipt: parsedCandidateTeardown,
    evidence: {
      platform: input.platform,
      runId: parsedCandidateTeardown.runId,
      candidateAttestation: parsedCandidateAttestation,
      candidateAttestationIdentity,
      driverRunManifest: runManifest,
      driverRunManifestIdentity: runManifestIdentity,
      ...(input.platform === "macos-installed"
        ? {
            macosNativeInputBinding: parsedMacosNativeInputBinding!,
            macosNativeInputBindingIdentity: runManifest.macosNativeInputBinding!,
          }
        : {
            webdriverLifecycle: parsedWebdriverLifecycle!,
            webdriverLifecycleIdentity: webdriverLifecycleIdentity!,
          }),
      profileCleanup: parsedProfileCleanup,
      profileCleanupIdentity,
    },
  });
  if (candidateTeardownErrors.length > 0) {
    throw new Error(`invalid candidate teardown receipt: ${candidateTeardownErrors.join("; ")}`);
  }
  const applicableIds = input.inventory.items
    .filter((surface) => surface.platforms.includes(input.platform))
    .map((surface) => surface.id)
    .sort();
  const observedIds = [...seenOutcomes].sort();
  if (JSON.stringify(applicableIds) !== JSON.stringify(observedIds)) {
    throw new Error(`driver reports do not cover the exact ${input.platform} inventory`);
  }

  return {
    schema: FINAL_SURFACE_RECEIPT_SCHEMA,
    mode: "final-frozen-candidate",
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    inventoryDigest: input.inventory.digest,
    startedAt: earliestIso(runManifest.startedAt, scenarioReport.startedAt),
    completedAt: latestIso(
      latestIso(runManifest.completedAt, scenarioReport.completedAt),
      parsedCandidateTeardown.completedAt,
    ),
    artifact: {
      basename: runManifest.artifact.basename,
      sha256: runManifest.artifact.sha256,
      signatureStatus: parsedSignatureReceipt.status,
    },
    evidenceArtifacts,
    transports: platformContract.requiredTransports.map((id) => ({ id, status: "pass", evidence: scenarioEvidenceId })),
    providers: input.contract.requiredProviders.map((id) => ({
      id,
      status: "pass",
      version: [...(routeVersionsByProvider.get(id) ?? [])].sort().join(" | "),
      evidence: scenarioEvidenceId,
    })),
    providerRoutes: scenarioReport.providerRoutes.map((route) => ({
      id: route.id,
      transportId: route.transportId,
      providerId: route.providerId,
      status: "pass",
      evidenceMode: route.evidenceMode,
      version: route.provider.version,
      executableSha256: route.provider.executableSha256,
      evidence: routeEvidenceIds.get(route.id)!,
    })),
    health: {
      startup: "pass",
      shutdown: "pass",
      brokenLinks: 0,
      unexpectedConsoleErrors: 0,
      evidence: healthEvidenceId,
    },
    outcomes,
  };
}

export function releaseSurfaceScenarioEvidencePath(
  scenarioReportPath: string,
  evidenceBasename: string,
): string {
  return join(dirname(resolve(scenarioReportPath)), evidenceBasename);
}

export function validateReleaseSurfaceMacosNativeInputComposition(input: {
  request: ReleaseSurfaceMacosNativeInputRequestBinding;
  runBinding: ReleaseSurfaceFileIdentity | undefined;
  evidence: ReleaseSurfaceMacosNativeInputBindingEvidence | null;
  candidate: ReleaseSurfaceCandidateAttestation;
}): string[] {
  const errors: string[] = [];
  if (!input.runBinding || !input.evidence) {
    return ["macOS native-input request has no exact run binding evidence"];
  }
  if (input.request.evidence.basename !== input.runBinding.basename
    || input.request.evidence.sha256 !== input.runBinding.sha256
    || input.request.evidence.bytes !== input.runBinding.bytes) {
    errors.push("macOS native-input request evidence does not match the exact driver-run binding");
  }
  errors.push(...validateReleaseSurfaceMacosNativeInputBinding({
    evidence: input.evidence,
    candidate: input.candidate,
    helperIdentity: input.request.helper,
  }));
  if (input.request.windowNumber !== input.evidence.window.number) {
    errors.push("macOS native-input request window does not match its exact binding receipt");
  }
  return errors;
}

function requireExactIdentity(
  actual: { basename: string; sha256: string; bytes: number },
  expected: { basename: string; sha256: string; bytes: number },
  label: string,
): void {
  if (actual.basename !== expected.basename || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error(`${label} identity does not match the driver run manifest`);
  }
}

function validateRunManifest(
  manifest: ReleaseSurfaceDriverRunManifest,
  input: ComposeFinalSurfaceReceiptInput,
): void {
  requireOnlyKeys(manifest, [
    "schema", "mode", "platform", "sourceCommit", "version", "inventoryDigest", "startedAt",
    "completedAt", "controller", "artifact", "signatureReceipt", "candidateAttestation",
    "installationReceipt", "candidateVerification", "signatureVerification", "nativeWebDriverBinding",
    "macosNativeInputBinding",
    "driverReports",
  ], "driver run manifest");
  for (const [value, label] of [
    [manifest.artifact, "driver run artifact"],
    [manifest.signatureReceipt, "driver run signature receipt"],
    [manifest.candidateAttestation, "driver run candidate attestation"],
    [manifest.installationReceipt, "driver run installation receipt"],
    ...(manifest.nativeWebDriverBinding
      ? [[manifest.nativeWebDriverBinding, "driver run native WebDriver binding"]] as const
      : []),
    ...(manifest.macosNativeInputBinding
      ? [[manifest.macosNativeInputBinding, "driver run macOS native-input binding"]] as const
      : []),
  ] as const) {
    requireOnlyKeys(value, ["basename", "sha256", "bytes"], label);
  }
  requireOnlyKeys(manifest.candidateVerification, [
    "installedPayloadSha256", "installedManifestSha256", "installedManifestBeforeCollectedAt",
    "installedManifestAfterCollectedAt", "processId", "instanceId", "debugBase", "debugTokenPath",
    "mcpBase", "mcpTokenPath", "buildCommit", "windowsNative", "posixNative",
  ], "driver run candidate verification");
  requireOnlyKeys(manifest.signatureVerification, ["status", "checks"], "driver run signature verification");
  if (manifest.schema !== RELEASE_SURFACE_DRIVER_RUN_SCHEMA) throw new Error(`driver run schema must be ${RELEASE_SURFACE_DRIVER_RUN_SCHEMA}`);
  if (manifest.mode !== "final-frozen-candidate") throw new Error("driver run mode must be final-frozen-candidate");
  for (const [field, expected, actual] of [
    ["platform", input.platform, manifest.platform],
    ["sourceCommit", input.sourceCommit, manifest.sourceCommit],
    ["version", input.version, manifest.version],
    ["inventoryDigest", input.inventory.digest, manifest.inventoryDigest],
  ] as const) {
    if (actual !== expected) throw new Error(`driver run ${field} does not match the frozen candidate`);
  }
  if (!validIsoRange(manifest.startedAt, manifest.completedAt)) throw new Error("driver run timestamps must be valid and ordered");
  const controllerErrors = validateReleaseSurfaceControllerBinding(manifest.controller);
  if (controllerErrors.length > 0) {
    throw new Error(`driver run controller binding is invalid: ${controllerErrors.join("; ")}`);
  }
  const liveControllerErrors = verifyReleaseSurfaceControllerBinding({
    rootDir: input.rootDir,
    binding: manifest.controller,
    requireClean: true,
  });
  if (liveControllerErrors.length > 0) {
    throw new Error(`driver run controller no longer matches the frozen source: ${liveControllerErrors.join("; ")}`);
  }
  const beforeManifest = Date.parse(manifest.candidateVerification?.installedManifestBeforeCollectedAt);
  const afterManifest = Date.parse(manifest.candidateVerification?.installedManifestAfterCollectedAt);
  const started = Date.parse(manifest.startedAt);
  const completed = Date.parse(manifest.completedAt);
  if (![beforeManifest, afterManifest, started, completed].every(Number.isFinite)
    || beforeManifest > started || afterManifest < started || afterManifest > completed) {
    throw new Error("driver run installed manifest observations must bracket execution");
  }
  if (!manifest.driverReports?.length) throw new Error("driver run manifest contains no reports");
  for (const row of manifest.driverReports) {
    requireOnlyKeys(row, [
      "basename", "sha256", "bytes", "driverId", "outcomes", "controller", "beforeProbe", "afterProbe",
    ], `driver run report ${String(row?.driverId ?? "unknown")}`);
    requireOnlyKeys(row.beforeProbe, ["basename", "sha256", "bytes"], `driver ${row.driverId} before probe identity`);
    requireOnlyKeys(row.afterProbe, ["basename", "sha256", "bytes"], `driver ${row.driverId} after probe identity`);
  }
}

function validateDriverRequestAgainstPlan(
  request: ReleaseSurfaceDriverRequest,
  driverId: string,
  driver: FinalSurfaceDriverPlan["drivers"][number],
  input: ComposeFinalSurfaceReceiptInput,
  planAssignments: Map<string, FinalSurfaceDriverPlan["assignments"][number]>,
  inventoryById: Map<string, ReleaseSurfaceInventory["items"][number]>,
  runManifest: ReleaseSurfaceDriverRunManifest,
  candidate: ReleaseSurfaceCandidateAttestation,
): void {
  if (request.schema !== RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA) throw new Error(`driver ${driverId} request schema is invalid`);
  for (const [field, expected, actual] of [
    ["driverId", driverId, request.driverId],
    ["driverKind", driver.kind, request.driverKind],
    ["platform", input.platform, request.platform],
    ["sourceCommit", input.sourceCommit, request.sourceCommit],
    ["version", input.version, request.version],
    ["inventoryDigest", input.inventory.digest, request.inventoryDigest],
  ] as const) {
    if (actual !== expected) throw new Error(`driver ${driverId} request ${field} does not match the exact plan/run`);
  }
  if (request.controller.entrypoint.relativePath !== driver.entrypoint) {
    throw new Error(`driver ${driverId} request controller entrypoint does not match the exact plan`);
  }
  if (request.artifact.basename !== runManifest.artifact.basename
    || request.artifact.sha256 !== runManifest.artifact.sha256) {
    throw new Error(`driver ${driverId} request artifact does not match the exact candidate`);
  }
  const expectedRuntime: ReleaseSurfaceDriverRequest["runtime"] = {
    processId: candidate.runtime.processId,
    instanceId: candidate.runtime.instanceId,
    debugBase: candidate.runtime.debugBase,
    debugTokenPath: candidate.runtime.debugTokenPath,
    mcpBase: candidate.runtime.mcpBase,
    mcpTokenPath: candidate.runtime.mcpTokenPath,
    executableSha256: candidate.process.executableSha256,
    installedPayloadPath: candidate.installedPayload.path,
    installedManifestSha256: candidate.installation.payloadManifestSha256,
    ...(candidate.windowsNativeRuntime
      ? { windowsNative: toReleaseSurfaceWindowsNativeBinding(candidate.windowsNativeRuntime) }
      : {}),
    ...(candidate.posixNativeRuntime
      ? { posixNative: toReleaseSurfacePosixNativeBinding(candidate.posixNativeRuntime) }
      : {}),
  };
  if (JSON.stringify(request.runtime) !== JSON.stringify(expectedRuntime)) {
    throw new Error(`driver ${driverId} request runtime does not match the exact candidate process`);
  }
  const nativeWebDriverRequired = releaseSurfaceDriverRequiresNativeWebDriver(driverId, driver.kind, input.platform);
  if (nativeWebDriverRequired && !request.nativeWebDriver) {
    throw new Error(`driver ${driverId} request is missing its same-process native WebDriver binding`);
  }
  if (!nativeWebDriverRequired && request.nativeWebDriver) {
    throw new Error(`driver ${driverId} request unexpectedly carries a native WebDriver binding`);
  }
  if (request.nativeWebDriver && (!runManifest.nativeWebDriverBinding
    || request.nativeWebDriver.evidence.basename !== runManifest.nativeWebDriverBinding.basename
    || request.nativeWebDriver.evidence.sha256 !== runManifest.nativeWebDriverBinding.sha256
    || request.nativeWebDriver.evidence.bytes !== runManifest.nativeWebDriverBinding.bytes)) {
    throw new Error(`driver ${driverId} request native WebDriver evidence does not match the run manifest`);
  }
  const macosNativeInputRequired = input.platform === "macos-installed"
    && releaseSurfaceDriverSupportsMacosNativeInput(driverId, driver.kind);
  if (macosNativeInputRequired && !request.macosNativeInput) {
    throw new Error(`driver ${driverId} request is missing its exact macOS native-input helper binding`);
  }
  if (!macosNativeInputRequired && request.macosNativeInput) {
    throw new Error(`driver ${driverId} request unexpectedly carries a macOS native-input helper binding`);
  }
  if (request.macosNativeInput && (!runManifest.macosNativeInputBinding
    || request.macosNativeInput.evidence.basename !== runManifest.macosNativeInputBinding.basename
    || request.macosNativeInput.evidence.sha256 !== runManifest.macosNativeInputBinding.sha256
    || request.macosNativeInput.evidence.bytes !== runManifest.macosNativeInputBinding.bytes)) {
    throw new Error(`driver ${driverId} request macOS native-input evidence does not match the run manifest`);
  }
  for (const row of request.assignments) {
    const assignment = planAssignments.get(assignmentCellKey(row.surface.id, input.platform));
    const surface = inventoryById.get(row.surface.id);
    if (!assignment || !surface) throw new Error(`driver ${driverId} request contains unknown surface ${row.surface.id}`);
    if (assignment.driverId !== driverId
      || assignment.fixtureId !== row.fixtureId
      || assignment.expectedEffect !== row.expectedEffect
      || assignment.oracleId !== row.oracleId
      || assignment.cleanupId !== row.cleanupId) {
      throw new Error(`driver ${driverId} request drifted from plan assignment ${row.surface.id}`);
    }
    if (JSON.stringify(surface) !== JSON.stringify(row.surface)) {
      throw new Error(`driver ${driverId} request drifted from inventory surface ${row.surface.id}`);
    }
  }
  const expectedIds = input.driverPlan.assignments
    .filter((row) => row.driverId === driverId
      && inventoryById.get(row.surfaceId)?.platforms.includes(input.platform))
    .map((row) => row.surfaceId)
    .sort();
  const actualIds = request.assignments.map((row) => row.surface.id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error(`driver ${driverId} request does not contain its exact plan assignments`);
  }
}

function identifyContainedFile(root: string, path: string, label: string): {
  basename: string;
  relativePath: string;
  sha256: string;
  bytes: number;
} {
  const absolute = requireContained(root, path, label);
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

function requireContainedDirectory(root: string, path: string, label: string): void {
  const absolute = requireContained(root, path, label);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular non-symlink directory`);
}

function requireContained(root: string, path: string, label: string): string {
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) {
    throw new Error(`${label} must be inside the private receipts directory`);
  }
  return absolute;
}

function validIsoRange(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function earliestIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latestIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function requireOnlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} contains undeclared field ${unknown}`);
}
